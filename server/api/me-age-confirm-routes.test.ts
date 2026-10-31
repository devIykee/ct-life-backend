/**
 * POST /v1/me/age-confirm: 18+ after character creation. It sets the same flag character
 * creation sets (`characters.age_confirmed_at`), so GET /me, GET /casino/state and the
 * Real Markets gate all flip; it is idempotent, audited (time + X-Client-Version) and
 * rate-limited. Real Postgres and Redis.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bootApi, type TestApi, type TestPlayer } from './http-test-kit.js';
import { createDb } from '../shared/db/pool.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { buildContext } from '../application/context.js';
import { AGE_BUCKET } from '../application/age-confirm.js';
import { deleteAccount } from '../application/account-deletion.js';

let api: TestApi;
const db = (): ReturnType<typeof createDb> => createDb();
const EDGE = { 'x-edge-auth': 'edge-secret-age', 'cf-ipcountry': 'NG' };

async function character(p: TestPlayer, confirmed: boolean): Promise<void> {
  await db().withConnection((c) =>
    c.query(
      `INSERT INTO characters (id, user_id, alias, look, tribe_id, trait_ids, dream_id, home_id, age_confirmed_at)
       VALUES ($1, $2, $3, '{}'::jsonb, 'degen', '{}', 'dream', 'parents_basement', $4)`,
      [uuidv7(), p.sub, `agec_${p.sub.slice(-12)}`, confirmed ? new Date() : null],
    ),
  );
}

async function confirm(
  p: TestPlayer,
  payload: unknown = { confirmed: true },
  headers: Record<string, string> = { 'x-client-version': '1.4.2' },
  idem: string = uuidv7(),
): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await api.app.inject({
    method: 'POST',
    url: '/v1/me/age-confirm',
    headers: { authorization: `Bearer ${p.accessToken}`, 'idempotency-key': idem, ...headers },
    payload: payload as Record<string, unknown>,
  });
  return { status: r.statusCode, body: r.json() as Record<string, unknown> };
}

async function audits(p: TestPlayer): Promise<Array<{ client_version: string | null }>> {
  const r = await db().withConnection((c) =>
    c.query<{ client_version: string | null }>(
      `SELECT client_version FROM age_confirmations WHERE user_id = $1`,
      [p.sub],
    ),
  );
  return r.rows;
}

const errCode = (r: { body: Record<string, unknown> }): string | undefined =>
  (r.body.error as { code?: string } | undefined)?.code;

describe('POST /v1/me/age-confirm', () => {
  beforeAll(async () => {
    api = await bootApi('realMarkets', {
      LIVE_PHASE: '6',
      REAL_MARKETS_EDGE_AUTH_HEADER: 'X-Edge-Auth',
      REAL_MARKETS_EDGE_AUTH_SECRET: 'edge-secret-age',
    });
  }, 30_000);
  beforeEach(async () => {
    const keys = await buildContext().redis.main.keys('rl:age-confirm:*');
    if (keys.length > 0) await buildContext().redis.main.del(...keys);
  });
  afterAll(async () => {
    await api.stop();
  }, 30_000);

  it('turns an unconfirmed account into a confirmed one everywhere the flag is read', async () => {
    const p = await api.player();
    await character(p, false);
    const before = await api.app.inject({
      method: 'GET',
      url: '/v1/real-markets/config',
      headers: { authorization: `Bearer ${p.accessToken}`, ...EDGE },
    });
    expect((before.json() as { reasons: string[] }).reasons).toContain('age_required');

    const r = await confirm(p);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ ageConfirmed: true, alreadyConfirmed: false });
    expect(Number.isNaN(Date.parse(r.body.ageConfirmedAt as string))).toBe(false);

    expect((await api.call(p, 'GET', '/v1/me')).body.ageConfirmed).toBe(true);
    expect((await api.call(p, 'GET', '/v1/casino/state')).body.ageConfirmed).toBe(true);
    const after = await api.app.inject({
      method: 'GET',
      url: '/v1/real-markets/config',
      headers: { authorization: `Bearer ${p.accessToken}`, ...EDGE },
    });
    const cfg = after.json() as { reasons: string[]; ageConfirmed: boolean };
    expect(cfg.ageConfirmed).toBe(true);
    expect(cfg.reasons).not.toContain('age_required');
    expect(await audits(p)).toEqual([{ client_version: '1.4.2' }]);
  });

  it('is idempotent: a repeat keeps the first time and writes no second audit row', async () => {
    const p = await api.player();
    await character(p, false);
    const first = await confirm(p);
    const again = await confirm(p, { confirmed: true }, { 'x-client-version': '1.5.0' });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      ageConfirmed: true,
      alreadyConfirmed: true,
      ageConfirmedAt: first.body.ageConfirmedAt,
    });
    expect(await audits(p)).toHaveLength(1);
  });

  it('leaves an account confirmed at character creation as it was (no audit row)', async () => {
    const p = await api.player();
    await character(p, true);
    const r = await confirm(p);
    expect(r.body).toMatchObject({ alreadyConfirmed: true });
    expect(await audits(p)).toHaveLength(0);
  });

  it('records a missing client version as null', async () => {
    const p = await api.player();
    await character(p, false);
    expect((await confirm(p, { confirmed: true }, {})).status).toBe(200);
    expect(await audits(p)).toEqual([{ client_version: null }]);
  });

  it('needs a character (404) and an explicit confirmed: true (400)', async () => {
    const none = await api.player();
    const r = await confirm(none);
    expect(r.status).toBe(404);
    expect(errCode(r)).toBe('NOT_FOUND');
    expect((r.body.error as { details: unknown }).details).toMatchObject({ kind: 'character' });

    const p = await api.player();
    await character(p, false);
    for (const bad of [{ confirmed: false }, {}, { confirmed: 'yes' }, { confirmed: true, x: 1 }]) {
      const b = await confirm(p, bad);
      expect(b.status, JSON.stringify(bad)).toBe(400);
      expect(errCode(b)).toBe('VALIDATION_FAILED');
    }
    const v = await confirm(p, { confirmed: true }, { 'x-client-version': 'a b<script>' });
    expect(v.status).toBe(400);
    expect((await api.call(p, 'GET', '/v1/me')).body.ageConfirmed).toBe(false);
  });

  it('is rate-limited per player (429 {reason: age_confirm})', async () => {
    const p = await api.player();
    await character(p, true);
    for (let i = 0; i < AGE_BUCKET.capacity; i++) expect((await confirm(p)).status).toBe(200);
    const r = await confirm(p);
    expect(r.status).toBe(429);
    expect((r.body.error as { details: unknown }).details).toMatchObject({ reason: 'age_confirm' });
  });

  it('deletes the audit rows with the account', async () => {
    const p = await api.player();
    await character(p, false);
    await confirm(p);
    expect(await audits(p)).toHaveLength(1);
    await deleteAccount(buildContext(), p.sub);
    expect(await audits(p)).toHaveLength(0);
  });

  it('needs auth', async () => {
    const r = await api.app.inject({
      method: 'POST',
      url: '/v1/me/age-confirm',
      headers: { 'idempotency-key': uuidv7() },
      payload: { confirmed: true },
    });
    expect(r.statusCode).toBe(401);
  });
});
