/** Real HTTP boundaries: config capability and invalid input rejected before persistence. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer, type ServerHandle } from './main.js';
import { buildContext } from '../application/context.js';
import { createDb } from '../shared/db/pool.js';
import {
  HUMAN_PALETTE_SOURCES,
  FITTED_HAIR_LOOKS,
  recoloured,
} from '../shared/domain/character-palette-fixtures.js';
let handle: ServerHandle;
let token: string;
const userId = randomUUID();
const schema = `test_palette_${randomUUID().replaceAll('-', '')}`;
let admin: Pool;
beforeAll(async () => {
  const database = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!database || !['localhost', '127.0.0.1', '::1'].includes(new URL(database).hostname))
    throw new Error('Character palette persistence tests require local Postgres');
  admin = new Pool({ connectionString: database });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = createDb({ connectionString: database, options: `-c search_path=${schema}` });
  await db.withConnection(async (c) => {
    await c.query(
      'CREATE TABLE users(id uuid PRIMARY KEY,wallet text,lottery_rolled_at timestamptz)',
    );
    for (const filename of [
      '1700000002000_characters.sql',
      '1700000005000_needs.sql',
      '1700000006000_skills.sql',
      '1700000075000_likeness_jobs.sql',
      '1700000076000_likeness_pipeline.sql',
      '1700000077000_likeness_delivery.sql',
      '1700000078000_character_likeness.sql',
    ]) {
      const sql = readFileSync(new URL(`../../db/migrations/${filename}`, import.meta.url), 'utf8');
      await c.query(sql.split('-- Down Migration')[0]!);
    }
    await c.query(
      'CREATE TABLE ledger_entries(user_id uuid,reason text,ref_id text,created_at timestamptz)',
    );
    // Character creation records a product event (migration 098).
    await c.query(
      `CREATE TABLE analytics_events(id bigserial PRIMARY KEY, occurred_at timestamptz NOT NULL DEFAULT now(),
       user_id uuid, name text NOT NULL, props jsonb NOT NULL DEFAULT '{}', amount_cents bigint)`,
    );
  });
  handle = await buildServer();
  await handle.app.ready();
  await buildContext().db.withConnection((c) =>
    c.query('INSERT INTO users (id,wallet,lottery_rolled_at) VALUES ($1,$2,now())', [
      userId,
      `palette-fixture-${userId}`,
    ]),
  );
  token = await buildContext().jwt.signAccess(userId, '11111111111111111111111111111111', false);
});
afterAll(async () => {
  if (handle) {
    await handle.stop();
  }
  if (admin) {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
const body = {
  alias: 'palette_fixture',
  ageConfirmed: true,
  traitIds: ['degen', 'builder'],
  tribeId: 'solana',
  dreamId: 'whale',
  look: {
    skinTone: 'skin_04',
    headId: 'head_ubc_f',
    hairId: 'hair_ubc_f__pink',
    topId: 'top_ubc_f__white',
    bottomId: 'bottom_ubc_f__navy',
    shoesId: 'shoes_ubc_f__black',
    accId: 'acc_none',
  },
};
// Real authored protocol IDs, snapshotted from the FE cast/import manifests on 2026-10-11.
// Keep this regression independent of a sibling checkout at test runtime.
const legacyLooks = [
  ...HUMAN_PALETTE_SOURCES,
  ...[
    'hero_assassin',
    'hero_gynoid',
    'hero_hazmat',
    'hero_balaclava',
    'ubc_m',
    'ubc_f',
    'pm_shark',
    'pm_froggy',
  ].map((id) => ({
    skinTone: 'skin_tone3',
    headId: `head_${id}`,
    hairId: `hair_${id}`,
    topId: `top_${id}`,
    bottomId: `bottom_${id}`,
    shoesId: `shoes_${id}`,
    accId: 'acc_none',
  })),
  ...HUMAN_PALETTE_SOURCES.map(recoloured),
  ...FITTED_HAIR_LOOKS,
];

function validIdentity() {
  const cache = buildContext().configCache;
  return {
    tribeId: cache.load<{ tribes: { id: string }[] }>('tribes').tribes[0]!.id,
    dreamId: cache.load<{ dreams: { id: string }[] }>('dreams').dreams[0]!.id,
    traitIds: cache
      .load<{ traits: { id: string }[] }>('traits')
      .traits.slice(0, 2)
      .map((t) => t.id),
  };
}
describe('character palette HTTP capability', () => {
  it.each(legacyLooks)(
    'keeps existing authored look $headId creatable and persistent',
    async (look) => {
      const id = randomUUID();
      await buildContext().db.withConnection((c) =>
        c.query('INSERT INTO users (id,wallet,lottery_rolled_at) VALUES ($1,$2,now())', [
          id,
          `legacy-palette-fixture-${id}`,
        ]),
      );
      const access = await buildContext().jwt.signAccess(
        id,
        '11111111111111111111111111111111',
        false,
      );
      const result = await handle.app.inject({
        method: 'POST',
        url: '/v1/characters',
        headers: { authorization: `Bearer ${access}`, 'idempotency-key': randomUUID() },
        payload: { ...body, ...validIdentity(), alias: `leg_${id.slice(0, 16)}`, look },
      });
      expect(result.statusCode).toBe(201);
      expect(result.json().look).toEqual(look);
      const saved = await buildContext().db.withConnection((c) =>
        c.query('SELECT look FROM characters WHERE user_id=$1', [id]),
      );
      expect(saved.rows[0]?.look).toEqual(look);
    },
  );
  it('persists independent palette choices through real character creation', async () => {
    const result = await handle.app.inject({
      method: 'POST',
      url: '/v1/characters',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
      payload: { ...body, alias: `pal_${userId.slice(0, 16)}`, ...validIdentity() },
    });
    expect(result.statusCode).toBe(201);
    expect(result.json().look).toEqual(body.look);
    const saved = await buildContext().db.withConnection((c) =>
      c.query('SELECT look FROM characters WHERE user_id=$1', [userId]),
    );
    expect(saved.rows[0]?.look).toEqual(body.look);
  });
  it('publishes per-head finite choices with an ETag', async () => {
    const response = await handle.app.inject({ method: 'GET', url: '/v1/config' });
    expect(response.statusCode).toBe(200);
    const palettes = response.json().characterPalettes;
    expect(palettes.version).toBe(1);
    expect(palettes.models.map((entry: { headId: string }) => entry.headId)).toEqual([
      'head_ubc_m',
      'head_ubc_f',
      ...HUMAN_PALETTE_SOURCES.map((source) => source.headId),
    ]);
    expect(palettes.models[0].skinTones).toHaveLength(11);
    expect(palettes.models[0].hairIds).toHaveLength(52);
    expect(palettes.models[1].hairIds).toContain('hair_ubc_f_parted__auburn');
    expect(palettes.models[2].hairIds).toContain('hair_snow_bun__auburn');
    expect(palettes.models[3].skinTones).toContain('skin_brown');
    expect(palettes.models[3].skinTones).not.toContain('skin_tone3');
    expect(palettes.models[1].topIds).toHaveLength(17);
    expect(palettes.models[1].topIds).toContain('top_ubc_f__sol_green');
    expect(palettes.models[1].topIds).not.toContain('top_ubc_m__sol_green');
    expect(response.headers.etag).toBeTruthy();
  });
  it.each([
    { hairId: 'hair_ubc_m__pink' },
    { shoesId: 'shoes_ubc_f__unknown' },
    { extra: 'unpublished-slot' },
  ])(
    'rejects unlisted body combinations or fields before creating a character: %j',
    async (change) => {
      const result = await handle.app.inject({
        method: 'POST',
        url: '/v1/characters',
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
        payload: { ...body, look: { ...body.look, ...change } },
      });
      expect(result.statusCode).toBe(400);
      expect(result.json().error.code).toBe('VALIDATION_FAILED');
    },
  );
});
