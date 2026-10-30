/**
 * GET /v1/me `ageConfirmed`: the same 18+ confirmation GET /casino/state
 * reports (`characters.age_confirmed_at`). False with no character or no
 * confirmation; true once confirmed. Ungated, like /casino/state.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApi, type TestApi, type TestPlayer } from './http-test-kit.js';
import { createDb } from '../shared/db/pool.js';
import { uuidv7 } from '../shared/domain/uuid.js';

let api: TestApi;
const db = (): ReturnType<typeof createDb> => createDb();

async function character(p: TestPlayer, confirmed: boolean): Promise<void> {
  await db().withConnection((c) =>
    c.query(
      `INSERT INTO characters (id, user_id, alias, look, tribe_id, trait_ids, dream_id, home_id, age_confirmed_at)
       VALUES ($1, $2, $3, '{}'::jsonb, 'degen', '{}', 'dream', 'parents_basement', $4)`,
      [uuidv7(), p.sub, `age_${p.sub.slice(-12)}`, confirmed ? new Date() : null],
    ),
  );
}

describe('GET /me ageConfirmed', () => {
  beforeAll(async () => {
    api = await bootApi('', { LIVE_PHASE: '6' });
  }, 30_000);
  afterAll(async () => {
    await api.stop();
  }, 30_000);

  it('is false without a character', async () => {
    const p = await api.player();
    const me = await api.call(p, 'GET', '/v1/me');
    expect(me.status).toBe(200);
    expect(me.body.ageConfirmed).toBe(false);
  });

  it('matches GET /casino/state before and after the 18+ confirmation', async () => {
    const kid = await api.player();
    await character(kid, false);
    const adult = await api.player();
    await character(adult, true);
    for (const [p, want] of [
      [kid, false],
      [adult, true],
    ] as const) {
      const me = await api.call(p, 'GET', '/v1/me');
      const casino = await api.call(p, 'GET', '/v1/casino/state');
      expect(me.body.ageConfirmed).toBe(want);
      expect(casino.body.ageConfirmed).toBe(want);
    }
  });
});
