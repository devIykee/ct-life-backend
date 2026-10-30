/**
 * GET /v1/districts/:id/standings and GET /v1/me/season-results over HTTP:
 * 503 CAPABILITY_OFF while each capability is off, 401 without a token, the
 * response shapes, 404 for an unknown district / no finished season, and 400
 * for a malformed seasonId. The scoring and season rules are covered in
 * server/application/league-standings.test.ts.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { Keypair } from '@solana/web3.js';
import { buildServer } from './main.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { _resetContextForTests } from '../application/context.js';
import { uuidv7 } from '../shared/domain/uuid.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const savedCaps = process.env.CAPABILITIES_ON;
let app: Awaited<ReturnType<typeof buildServer>>['app'] | null = null;
let stop: (() => Promise<void>) | null = null;

async function boot(caps: string): Promise<void> {
  if (stop) await stop();
  process.env.CAPABILITIES_ON = caps;
  process.env.ENABLE_DEV_AUTH = 'true';
  _resetConfigForTests();
  _resetContextForTests();
  const handle = await buildServer();
  app = handle.app;
  await app.ready();
  stop = handle.stop;
}

async function devUser(): Promise<{ id: string; token: string }> {
  const r = await app!.inject({
    method: 'POST',
    url: '/v1/auth/dev',
    headers: { 'idempotency-key': `wpa-${uuidv7()}` },
    payload: { wallet: Keypair.generate().publicKey.toBase58() },
  });
  expect(r.statusCode, r.body).toBe(200);
  const b = r.json() as { id: string; accessToken: string };
  return { id: b.id, token: b.accessToken };
}

async function get(token: string | null, url: string): Promise<{ status: number; body: any }> {
  const r = await app!.inject({
    method: 'GET',
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: r.statusCode, body: r.json() };
}

afterAll(async () => {
  if (stop) await stop();
  if (savedCaps === undefined) delete process.env.CAPABILITIES_ON;
  else process.env.CAPABILITIES_ON = savedCaps;
  _resetConfigForTests();
  _resetContextForTests();
  await pool.end();
}, 30_000);

describe('league routes', () => {
  it('both answer 503 CAPABILITY_OFF while off', async () => {
    await boot('');
    const u = await devUser();
    const a = await get(u.token, '/v1/districts/the_trenches/standings');
    expect(a.status).toBe(503);
    expect(a.body.error.details).toEqual({ capability: 'districtStandings' });
    const b = await get(u.token, '/v1/me/season-results');
    expect(b.status).toBe(503);
    expect(b.body.error.details).toEqual({ capability: 'seasonResults' });
  }, 30_000);

  it('standings: 401, 404, and the shape for a known district', async () => {
    await boot('districtStandings,seasonResults');
    const u = await devUser();
    expect((await get(null, '/v1/districts/the_trenches/standings')).status).toBe(401);
    expect((await get(u.token, '/v1/districts/nope_district/standings')).status).toBe(404);
    const districts = await get(u.token, '/v1/districts');
    const id = (districts.body.districts as Array<{ districtId: string }>)[0]!.districtId;
    const r = await get(u.token, `/v1/districts/${id}/standings`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.districtId).toBe(id);
    expect(r.body.dayDate).toBe(new Date().toISOString().slice(0, 10));
    expect(Date.parse(r.body.rolloverAt)).toBeGreaterThan(Date.now());
    expect(Array.isArray(r.body.standings)).toBe(true);
    for (const row of r.body.standings) {
      expect(typeof row.tribeId).toBe('string');
      expect(Number.isInteger(row.score)).toBe(true);
    }
    expect('myTribeId' in r.body && 'myContribution' in r.body).toBe(true);
  }, 30_000);

  it('season results: 401, 404 with no finished season, 400 malformed, 200 with one', async () => {
    await boot('districtStandings,seasonResults');
    const u = await devUser();
    expect((await get(null, '/v1/me/season-results')).status).toBe(401);
    const none = await get(u.token, '/v1/me/season-results');
    expect(none.status).toBe(404);
    expect(none.body.error.code).toBe('NOT_FOUND');
    expect((await get(u.token, '/v1/me/season-results?seasonId=s1')).status).toBe(400);
    const { ensureLeagues } = await import('../application/leagues.js');
    const { buildContext } = await import('../application/context.js');
    await ensureLeagues(buildContext());
    await pool.query(
      `INSERT INTO season_memberships (membership_id, user_id, season_iso, league_id, net_worth_cents, rank)
       VALUES ($1, $2, '2002-W05', 'bronze', 200000, 4)`,
      [uuidv7(), u.id],
    );
    const r = await get(u.token, '/v1/me/season-results?seasonId=2002-W05');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({
      seasonId: '2002-W05',
      leagueId: 'bronze',
      finalRank: 4,
      outcome: 'stayed',
      toLeagueId: null,
      rewards: [],
    });
    await pool.query(`DELETE FROM season_memberships WHERE user_id = $1`, [u.id]);
  }, 30_000);
});
