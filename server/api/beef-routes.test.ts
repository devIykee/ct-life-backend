/**
 * CT Beef over HTTP (unlock A6): every player route answers 503
 * CAPABILITY_OFF while the app capability `beef` is off and votes also need
 * `beefVoting`; POST /beef echoes topicId / invitedUserId / stakeCents 0 (the
 * client checks the echo) and refuses stakes; accept / decline / cancel /
 * GET /beef/:id / scope=mine; votes 201, 403 VOTE_NOT_ALLOWED, 409
 * ALREADY_VOTED and 409 not_voting; admin settle stays 403 for players. The
 * phase rules are covered in server/application/ratio-arena.test.ts.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { Keypair } from '@solana/web3.js';
import { buildServer } from './main.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { _resetContextForTests } from '../application/context.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { _shifts } from '../application/shifts.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const savedCaps = process.env.CAPABILITIES_ON;
let app: Awaited<ReturnType<typeof buildServer>>['app'] | null = null;
let stop: (() => Promise<void>) | null = null;
const TOPIC = 'beef_memes_vs_utility';

interface U {
  id: string;
  token: string;
}

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

/** Paid server-timed shifts on `n` distinct past UTC days. */
async function shiftDays(userId: string, n: number): Promise<void> {
  for (let d = 1; d <= n; d++) {
    await pool.query(
      `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, created_at)
       VALUES ($1, 4000, 'cash', 'shift_pay', 'shift', $2, now() - make_interval(days => $3))`,
      [userId, uuidv7(), d],
    );
  }
}

/** A dev-auth player; `veteran` makes them old enough and leveled to play and vote. */
async function devUser(veteran = false): Promise<U> {
  const r = await app!.inject({
    method: 'POST',
    url: '/v1/auth/dev',
    headers: { 'idempotency-key': `wpa-${uuidv7()}` },
    payload: { wallet: Keypair.generate().publicKey.toBase58() },
  });
  expect(r.statusCode, r.body).toBe(200);
  const b = r.json() as { id: string; accessToken: string };
  if (veteran) {
    await pool.query(`UPDATE users SET created_at = now() - interval '3 days' WHERE id = $1`, [
      b.id,
    ]);
    await shiftDays(b.id, 2);
  }
  return { id: b.id, token: b.accessToken };
}

async function call(
  u: U,
  method: 'GET' | 'POST',
  url: string,
  payload?: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const r = await app!.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${u.token}`,
      ...(method === 'POST' ? { 'idempotency-key': uuidv7() } : {}),
    },
    ...(payload ? { payload } : {}),
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

describe('beef routes', () => {
  it('answers 503 CAPABILITY_OFF while beef is off', async () => {
    await boot('');
    const u = await devUser();
    for (const [method, url] of [
      ['GET', '/v1/beef'],
      ['GET', '/v1/beef/eligibility'],
      ['POST', '/v1/beef'],
      ['GET', `/v1/beef/${uuidv7()}`],
      ['POST', `/v1/beef/${uuidv7()}/accept`],
      ['POST', `/v1/beef/${uuidv7()}/cancel`],
      ['POST', `/v1/beef/${uuidv7()}/votes`],
    ] as const) {
      const r = await call(u, method, url, method === 'POST' ? { topicId: TOPIC } : undefined);
      expect(r.status, `${method} ${url}`).toBe(503);
      expect(r.body.error.details).toEqual({ capability: 'beef' });
    }
    const cfg = await app!.inject({ method: 'GET', url: '/v1/config' });
    expect((cfg.json() as { beef: unknown }).beef).toBeNull();
  }, 30_000);

  it('GET /config serves the beef block while beef is on', async () => {
    await boot('beef');
    const cfg = (await app!.inject({ method: 'GET', url: '/v1/config' })).json() as {
      beef: Record<string, unknown>;
    };
    expect(cfg.beef).toEqual({
      version: '1.0.0',
      topics: expect.arrayContaining([{ id: TOPIC, label: 'Memes vs utility' }]),
      winnerRewardCents: 10000,
      maxRewardedWinsPerDay: 3,
      minAccountAgeHours: 48,
      minShiftDays: 2,
      voters: { minAccountAgeHours: 48, minShiftDays: 2 },
    });
    expect((cfg.beef.topics as unknown[]).length).toBe(6);
  }, 30_000);

  it('GET /beef/eligibility shows progress and agrees with POST /beef', async () => {
    await boot('beef');
    const fresh = await devUser();
    const e = await call(fresh, 'GET', '/v1/beef/eligibility');
    expect(e.status).toBe(200);
    expect(e.body).toMatchObject({
      eligible: false,
      accountAgeOk: false,
      minAccountAgeHours: 48,
      shiftDays: 0,
      requiredShiftDays: 2,
      reasons: ['too_new', 'shift_days'],
    });
    expect(Date.parse(e.body.accountAgeOkAt)).toBeGreaterThan(Date.now());
    expect((await call(fresh, 'POST', '/v1/beef', { topicId: TOPIC })).status).toBe(403);

    // Old enough, one shift day: only shift_days left.
    await pool.query(`UPDATE users SET created_at = now() - interval '3 days' WHERE id = $1`, [
      fresh.id,
    ]);
    await shiftDays(fresh.id, 1);
    const half = await call(fresh, 'GET', '/v1/beef/eligibility');
    expect(half.body).toMatchObject({
      eligible: false,
      accountAgeOk: true,
      shiftDays: 1,
      reasons: ['shift_days'],
    });

    const vet = await devUser(true);
    const ok = await call(vet, 'GET', '/v1/beef/eligibility');
    expect(ok.body).toMatchObject({
      eligible: true,
      accountAgeOk: true,
      shiftDays: 2,
      reasons: [],
    });
    expect((await call(vet, 'POST', '/v1/beef', { topicId: TOPIC })).status).toBe(201);

    // A sybil-jailed veteran is not eligible either.
    const jailed = await devUser(true);
    await pool.query(`UPDATE users SET is_sybil_jailed = true WHERE id = $1`, [jailed.id]);
    const j = await call(jailed, 'GET', '/v1/beef/eligibility');
    expect(j.body).toMatchObject({ eligible: false, reasons: ['sybil_jailed'] });
    const refused = await call(jailed, 'POST', '/v1/beef', { topicId: TOPIC });
    expect(refused.body.error.code).toBe('SYBIL_JAILED');
  }, 30_000);

  it('opens stake-free, echoes the terms, and runs accept / decline / cancel', async () => {
    await boot('beef');
    const a = await devUser(true);
    const b = await devUser(true);
    const c = await devUser(true);
    // A brand-new account cannot open a beef (anti alt-farming).
    const fresh = await devUser();
    const tooNew = await call(fresh, 'POST', '/v1/beef', { topicId: TOPIC });
    expect(tooNew.status).toBe(403);
    expect(tooNew.body.error).toMatchObject({ code: 'FORBIDDEN', details: { reason: 'too_new' } });
    const staked = await call(a, 'POST', '/v1/beef', { topicId: TOPIC, stakeCents: 5000 });
    expect(staked.status).toBe(400);
    expect(staked.body.error.details.reason).toBe('stakes_disabled');
    expect((await call(a, 'POST', '/v1/beef', { topicId: 'nope' })).status).toBe(400);

    const aimed = await call(a, 'POST', '/v1/beef', {
      topicId: TOPIC,
      invitedUserId: b.id,
      stakeCents: 0,
    });
    expect(aimed.status, JSON.stringify(aimed.body)).toBe(201);
    expect(aimed.body).toMatchObject({
      topicId: TOPIC,
      invitedUserId: b.id,
      stakeCents: 0,
      rewardCents: expect.any(Number),
      status: 'open',
      votes: null,
      crowdVotes: null,
    });
    const id = aimed.body.matchId as string;
    expect((await call(c, 'POST', `/v1/beef/${id}/accept`)).status).toBe(403);
    const mine = await call(b, 'GET', '/v1/beef?scope=mine');
    expect(mine.body.matches.map((m: { matchId: string }) => m.matchId)).toContain(id);
    const one = await call(c, 'GET', `/v1/beef/${id}`);
    expect(one.body.matchId).toBe(id);
    expect((await call(c, 'GET', `/v1/beef/${uuidv7()}`)).status).toBe(404);

    const declined = await call(b, 'POST', `/v1/beef/${id}/decline`);
    expect(declined.status).toBe(200);
    expect(declined.body.status).toBe('declined');

    const open = await call(a, 'POST', '/v1/beef', { topicId: TOPIC });
    const oid = open.body.matchId as string;
    expect((await call(c, 'POST', `/v1/beef/${oid}/cancel`)).status).toBe(403);
    const cancelled = await call(a, 'POST', `/v1/beef/${oid}/cancel`);
    expect(cancelled.body.status).toBe('cancelled');
    const again = await call(a, 'POST', `/v1/beef/${oid}/cancel`);
    expect(again.status).toBe(409);
    expect(again.body.error.details.reason).toBe('not_open');

    const live = await call(a, 'POST', '/v1/beef', { topicId: TOPIC });
    const acc = await call(c, 'POST', `/v1/beef/${live.body.matchId}/accept`);
    expect(acc.status).toBe(200);
    expect(acc.body).toMatchObject({ status: 'active', accepterUserId: c.id });
    // Votes need beefVoting too.
    const v = await call(b, 'POST', `/v1/beef/${live.body.matchId}/votes`, { votedUserId: a.id });
    expect(v.status).toBe(503);
    expect(v.body.error.details).toEqual({ capability: 'beefVoting' });
    // Settle stays admin-only.
    const s = await call(a, 'POST', `/v1/beef/${live.body.matchId}/settle`, { winnerUserId: a.id });
    expect(s.status).toBe(403);
    const elo = await call(a, 'GET', `/v1/beef/elo?userId=${c.id}`);
    expect(elo.body).toMatchObject({ userId: c.id, elo: 1500 });
  }, 30_000);

  it('votes during the voting phase only, once, never by a participant', async () => {
    await boot('beef,beefVoting');
    const a = await devUser(true);
    const b = await devUser(true);
    const voter = await devUser(true);
    const fresh = await devUser();
    const m = await call(a, 'POST', '/v1/beef', { topicId: TOPIC });
    const id = m.body.matchId as string;
    await call(b, 'POST', `/v1/beef/${id}/accept`);
    const early = await call(voter, 'POST', `/v1/beef/${id}/votes`, { votedUserId: a.id });
    expect(early.status).toBe(409);
    expect(early.body.error.details.reason).toBe('not_voting');
    // Fast-forward the debate into the voting phase.
    await pool.query(
      `UPDATE beef_matches SET status = 'voting', phase_ends_at = now() + interval '10 minutes'
        WHERE match_id = $1`,
      [id],
    );
    const ok = await call(voter, 'POST', `/v1/beef/${id}/votes`, { votedUserId: a.id });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ matchId: id, votedUserId: a.id });
    const dup = await call(voter, 'POST', `/v1/beef/${id}/votes`, { votedUserId: b.id });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('ALREADY_VOTED');
    const self = await call(a, 'POST', `/v1/beef/${id}/votes`, { votedUserId: a.id });
    expect(self.status).toBe(403);
    expect(self.body.error).toMatchObject({
      code: 'VOTE_NOT_ALLOWED',
      details: { reason: 'participant' },
    });
    const young = await call(fresh, 'POST', `/v1/beef/${id}/votes`, { votedUserId: a.id });
    expect(young.body.error).toMatchObject({
      code: 'VOTE_NOT_ALLOWED',
      details: { reason: 'too_new' },
    });
    const view = await call(voter, 'GET', `/v1/beef/${id}`);
    expect(view.body.votes).toBeNull();
    expect(view.body.myVote).toBe(a.id);
  }, 30_000);

  it('client scores alone never qualify; paid shifts on two days do', async () => {
    await boot('beef');
    const p = await devUser();
    await pool.query(`UPDATE users SET created_at = now() - interval '4 days' WHERE id = $1`, [
      p.id,
    ]);
    expect((await call(p, 'POST', '/v1/careers/discord_mod/apply', {})).status).toBe(200);
    // Day 1: a perfect shift with a maxed client-reported score (promotes the career).
    const work = async (): Promise<void> => {
      const start = await call(p, 'POST', '/v1/shifts', { careerId: 'discord_mod' });
      expect(start.status, JSON.stringify(start.body)).toBe(200);
      const shiftId = start.body.shiftId as string;
      _shifts.set(shiftId, { ..._shifts.get(shiftId)!, endsAt: 0 });
      const done = await call(p, 'POST', `/v1/shifts/${shiftId}/complete`, {
        results: [{ miniGameId: 'discord_mod_ban', score: 10 }],
      });
      expect(done.status, JSON.stringify(done.body)).toBe(200);
    };
    await work();
    await work();
    const sameDay = await call(p, 'POST', '/v1/beef', { topicId: TOPIC });
    expect(sameDay.status).toBe(403);
    expect(sameDay.body.error.details).toMatchObject({ reason: 'shift_days', shiftDays: 1 });
    // A shift paid on an earlier UTC day (a second day of play) qualifies.
    await shiftDays(p.id, 1);
    const ok = await call(p, 'POST', '/v1/beef', { topicId: TOPIC });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  }, 30_000);
});
