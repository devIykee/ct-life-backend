/**
 * Paid calls + creator mode (unlock C2) over HTTP, against a fake escrow chain:
 * dark until paidCalls / creatorMode are on; creator terms on PUT /creator and
 * GET /users/:id; booking builds the fan's tx for the right deposit; funding is
 * verified against the Session account; accept, server-timed end and settle; decline
 * and unanswered calls are refunded by the sweep once the window passes; a live call is
 * ended at its booked minutes. Real DB; no RPC and no keys.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { Pool } from 'pg';
import { Keypair } from '@solana/web3.js';
import { buildServer } from './main.js';
import { buildContext, _resetContextForTests } from '../application/context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import {
  _setEscrowChainForTests,
  type EscrowChain,
  type OpenCheck,
  type SessionClosure,
  type SessionRef,
  type TokenAccountState,
} from '../application/paid-call-chain.js';
import {
  _resetAuthorityBalanceForTests,
  MAX_SWEEP_ATTEMPTS,
  requeueStuckCalls,
  sweepPaidCalls,
} from '../application/paid-calls.js';
import type { EscrowSession } from '../shared/solana/ct-escrow.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { AccessToken } from 'livekit-server-sdk';
import { createHash } from 'node:crypto';

loadDotenv({ path: process.cwd() + '/.env' });

const savedCaps = process.env.CAPABILITIES_ON;
const pool = new Pool({
  connectionString: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL,
});
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

const sessions = new Map<string, EscrowSession>();
let sent: string[] = [];
let openCheck: OpenCheck = 'ok';
let closureResult: SessionClosure | null = null;
let settleFails = false;
let refundFails = false;
let settleRent = 0n;
let accountStates: Record<string, TokenAccountState> = {};
let authorityLamports = 1_000_000_000n;
const key = (r: SessionRef): string => `${r.fan}:${r.creator}:${r.sessionId}`;

const fakeChain: EscrowChain = {
  async config() {
    const k = Keypair.generate().publicKey.toBase58();
    return {
      admin: k,
      settleAuthority: k,
      treasury: k,
      usdcMint: USDC,
      vault: k,
      feeBps: 1000,
      acceptWindowSecs: 120,
    };
  },
  async session(_ctx, ref) {
    return sessions.get(key(ref)) ?? null;
  },
  async buildOpen(_ctx, ref) {
    sent.push(`build:${ref.ratePerMin}:${ref.maxMinutes}`);
    return Buffer.from('unsigned-v0').toString('base64');
  },
  async verifyOpen() {
    return openCheck;
  },
  async closure() {
    return closureResult;
  },
  async usdcAccounts(_ctx, owners) {
    return Object.fromEntries(owners.map((o) => [o, accountStates[o] ?? 'ok']));
  },
  async authorityLamports() {
    return authorityLamports;
  },
  async accept(_ctx, ref) {
    const s = sessions.get(key(ref))!;
    sessions.set(key(ref), { ...s, status: 1 });
    sent.push('accept');
    return `accept${uuidv7()}`;
  },
  async settle(_ctx, ref) {
    if (settleFails) throw new Error('blockhash expired');
    sessions.delete(key(ref));
    sent.push(`settle:${ref.secondsUsed}`);
    return {
      signature: `settle${uuidv7()}`,
      rentLamports: settleRent,
      fanRentLamports: settleRent,
      creatorRentLamports: 0n,
    };
  },
  async refund(_ctx, ref) {
    if (refundFails) throw new Error('InvalidAccountData');
    sessions.delete(key(ref));
    sent.push('refund');
    return {
      signature: `refund${uuidv7()}`,
      rentLamports: 0n,
      fanRentLamports: 0n,
      creatorRentLamports: 0n,
    };
  },
};

let app: Awaited<ReturnType<typeof buildServer>>['app'];
let stop: (() => Promise<void>) | null = null;

async function boot(caps: string | undefined): Promise<void> {
  if (caps === undefined) delete process.env.CAPABILITIES_ON;
  else process.env.CAPABILITIES_ON = caps;
  process.env.LOG_LEVEL = 'warn';
  _resetConfigForTests();
  _resetContextForTests();
  const handle = await buildServer();
  app = handle.app;
  await app.ready();
  stop = handle.stop;
}

interface Authed {
  id: string;
  wallet: string;
  token: string;
}

async function devAuth(): Promise<Authed> {
  const wallet = Keypair.generate().publicKey.toBase58();
  const r = await app.inject({
    method: 'POST',
    url: '/v1/auth/dev',
    headers: { 'idempotency-key': `c2-${uuidv7()}` },
    payload: { wallet },
  });
  expect(r.statusCode, r.body).toBe(200);
  const b = r.json() as { id: string; accessToken: string };
  return { id: b.id, wallet, token: b.accessToken };
}

async function call(u: Authed, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const r = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${u.token}`,
      ...(method === 'GET' ? {} : { 'idempotency-key': uuidv7() }),
    },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
  return {
    status: r.statusCode,
    body: (r.body === '' ? {} : r.json()) as Record<string, unknown>,
  };
}

const errOf = (b: Record<string, unknown>) =>
  b.error as { code: string; details: Record<string, unknown> };

/** Turn on creator mode at 0.5 USDC/min, 10 min max. */
async function creator(): Promise<Authed> {
  const c = await devAuth();
  const r = await call(c, 'PUT', '/v1/creator', {
    enabled: true,
    ratePerMinUsdc: '500000',
    maxMinutes: 10,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return c;
}

/** The fan's wallet sends the open_session: the Session account appears. */
async function fund(callId: string, override: Partial<EscrowSession> = {}): Promise<void> {
  const r = await pool.query<{
    fan_wallet: string;
    creator_wallet: string;
    session_id: string;
    rate_per_min: string;
    max_minutes: number;
    deposit: string;
  }>('SELECT * FROM paid_calls WHERE call_id = $1', [callId]);
  const row = r.rows[0]!;
  const ref = {
    fan: row.fan_wallet,
    creator: row.creator_wallet,
    sessionId: BigInt(row.session_id),
  };
  sessions.set(key(ref), {
    sessionId: BigInt(row.session_id),
    fan: row.fan_wallet,
    creator: row.creator_wallet,
    ratePerMin: BigInt(row.rate_per_min),
    maxMinutes: row.max_minutes,
    deposit: BigInt(row.deposit),
    feeBps: 1000,
    openedAt: BigInt(Math.floor(Date.now() / 1000)),
    acceptedAt: 0n,
    settledAt: 0n,
    status: 0,
    ...override,
  });
}

const SIG = (): string => `${uuidv7().replace(/-/g, '')}${uuidv7().replace(/-/g, '')}`;

async function ringing(fan: Authed, c: Authed, minutes = 5): Promise<string> {
  const b = await call(fan, 'POST', '/v1/paid-calls', { creatorId: c.id, minutes });
  expect(b.status, JSON.stringify(b.body)).toBe(201);
  const callId = b.body.callId as string;
  await fund(callId);
  const s = await call(fan, 'POST', `/v1/paid-calls/${callId}/submitted`, { signature: SIG() });
  expect(s.status, JSON.stringify(s.body)).toBe(200);
  expect(s.body.status).toBe('ringing');
  return callId;
}

beforeEach(() => {
  _setEscrowChainForTests(fakeChain);
  sent = [];
  openCheck = 'ok';
  closureResult = null;
  settleFails = false;
  refundFails = false;
  settleRent = 0n;
  accountStates = {};
  authorityLamports = 1_000_000_000n;
  _resetAuthorityBalanceForTests();
});

afterEach(async () => {
  if (stop) await stop();
  stop = null;
});

afterAll(async () => {
  _setEscrowChainForTests(null);
  if (savedCaps === undefined) delete process.env.CAPABILITIES_ON;
  else process.env.CAPABILITIES_ON = savedCaps;
  _resetConfigForTests();
  _resetContextForTests();
  await pool.end();
});

const ON = 'paidCalls,creatorMode';

describe('paid calls and creator mode', () => {
  it('are dark until their capabilities are on', async () => {
    await boot(undefined);
    const u = await devAuth();
    const put = await call(u, 'PUT', '/v1/creator', {
      enabled: true,
      ratePerMinUsdc: '500000',
      maxMinutes: 10,
    });
    expect(put.status).toBe(503);
    expect(errOf(put.body).details.capability).toBe('creatorMode');
    const book = await call(u, 'POST', '/v1/paid-calls', { creatorId: uuidv7(), minutes: 1 });
    expect(book.status).toBe(503);
    expect(errOf(book.body).details.capability).toBe('paidCalls');
    const profile = await call(u, 'GET', `/v1/users/${u.id}`);
    expect(profile.status).toBe(200);
    expect(profile.body.creator).toBeNull();
  }, 30_000);

  it('PUT /creator validates the rate and minutes; GET /users/:id shows the terms', async () => {
    await boot(ON);
    const u = await devAuth();
    for (const [body, reason] of [
      [{ enabled: true, ratePerMinUsdc: '249999', maxMinutes: 5 }, 'rate_out_of_range'],
      [{ enabled: true, ratePerMinUsdc: '50000001', maxMinutes: 5 }, 'rate_out_of_range'],
      [{ enabled: true, ratePerMinUsdc: '0.5', maxMinutes: 5 }, 'rate_out_of_range'],
      [{ enabled: true, ratePerMinUsdc: '500000', maxMinutes: 61 }, 'max_minutes'],
      [{ enabled: true, ratePerMinUsdc: '500000', maxMinutes: 0 }, 'max_minutes'],
    ] as const) {
      const r = await call(u, 'PUT', '/v1/creator', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(errOf(r.body).details.reason).toBe(reason);
    }
    const ok = await call(u, 'PUT', '/v1/creator', {
      enabled: true,
      ratePerMinUsdc: '500000',
      maxMinutes: 10,
    });
    expect(ok.body).toEqual({ enabled: true, ratePerMinUsdc: '500000', maxMinutes: 10 });
    const viewer = await devAuth();
    const p = await call(viewer, 'GET', `/v1/users/${u.id}`);
    expect(p.body.creator).toEqual({ enabled: true, ratePerMinUsdc: '500000', maxMinutes: 10 });
    expect(JSON.stringify(p.body)).not.toContain('payout');
  }, 30_000);

  it('books, verifies the funding, accepts, and settles the server-timed call', async () => {
    await boot(ON);
    const c = await creator();
    const fan = await devAuth();
    const b = await call(fan, 'POST', '/v1/paid-calls', { creatorId: c.id, minutes: 5 });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    // 0.5 USDC x 5 min x 1.10 (fee on top) = 2.75 USDC.
    expect(b.body).toMatchObject({
      amount: '2750000',
      feeBps: 1000,
      ratePerMinUsdc: '500000',
      minutes: 5,
    });
    expect(typeof b.body.tx).toBe('string');
    expect(typeof b.body.sessionPda).toBe('string');
    expect(sent).toEqual(['build:500000:5']);
    const callId = b.body.callId as string;

    // A second booking while this one is open is refused.
    const again = await call(fan, 'POST', '/v1/paid-calls', { creatorId: c.id, minutes: 1 });
    expect(again.status).toBe(409);
    expect(errOf(again.body).details.reason).toBe('call_in_progress');

    // Reported before the Session exists: retry later.
    const early = await call(fan, 'POST', `/v1/paid-calls/${callId}/submitted`, {
      signature: SIG(),
    });
    expect(early.status).toBe(409);
    expect(errOf(early.body).details.reason).toBe('not_found_yet');

    await fund(callId);
    const sub = await call(fan, 'POST', `/v1/paid-calls/${callId}/submitted`, { signature: SIG() });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    expect(sub.body).toMatchObject({ status: 'ringing', deposit: '2750000' });

    // Nobody can join the voice room before the accept.
    const early2 = await call(fan, 'POST', '/v1/rtc/token', { kind: 'paid_call', id: callId });
    expect(early2.status).toBe(403);
    // Only the creator accepts.
    expect((await call(fan, 'POST', `/v1/paid-calls/${callId}/accept`)).status).toBe(403);
    const acc = await call(c, 'POST', `/v1/paid-calls/${callId}/accept`);
    expect(acc.status, JSON.stringify(acc.body)).toBe(200);
    expect(acc.body.status).toBe('live');
    expect(sent).toContain('accept');
    const tok = await call(fan, 'POST', '/v1/rtc/token', { kind: 'paid_call', id: callId });
    expect(tok.status, JSON.stringify(tok.body)).toBe(200);
    const stranger = await devAuth();
    expect((await call(stranger, 'GET', `/v1/paid-calls/${callId}`)).status).toBe(404);

    // 61 seconds in: two minutes billed.
    await pool.query(
      `UPDATE paid_calls SET accepted_at = now() - interval '61 seconds' WHERE call_id = $1`,
      [callId],
    );
    const end = await call(fan, 'POST', `/v1/paid-calls/${callId}/end`);
    expect(end.status, JSON.stringify(end.body)).toBe(200);
    expect(end.body).toMatchObject({
      status: 'settled',
      minutesUsed: 2,
      creatorAmount: '1000000',
      feeAmount: '100000',
      refundAmount: '1650000',
      endReason: 'fan_ended',
    });
    expect(sent.some((s) => s === 'settle:61' || s === 'settle:62')).toBe(true);
    // Ending twice is a no-op.
    expect((await call(c, 'POST', `/v1/paid-calls/${callId}/end`)).body.status).toBe('settled');
  }, 30_000);

  it('refuses unknown or disabled creators, too many minutes, self calls and blocked pairs', async () => {
    await boot(ON);
    const fan = await devAuth();
    const plain = await devAuth();
    const r1 = await call(fan, 'POST', '/v1/paid-calls', { creatorId: plain.id, minutes: 1 });
    expect(r1.status).toBe(403);
    expect(errOf(r1.body).code).toBe('CREATOR_UNAVAILABLE');
    const c = await creator();
    const r2 = await call(fan, 'POST', '/v1/paid-calls', { creatorId: c.id, minutes: 11 });
    expect(r2.status).toBe(400);
    expect(errOf(r2.body).details.reason).toBe('minutes_over_max');
    const r3 = await call(c, 'POST', '/v1/paid-calls', { creatorId: c.id, minutes: 1 });
    expect(r3.status).toBe(400);
    await pool.query(
      `INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2), ($2, $1)`,
      [fan.id, c.id],
    );
    const r4 = await call(fan, 'POST', '/v1/paid-calls', { creatorId: c.id, minutes: 1 });
    expect(r4.status).toBe(403);
    expect(errOf(r4.body).code).toBe('BLOCKED');
    await call(c, 'PUT', '/v1/creator', {
      enabled: false,
      ratePerMinUsdc: '500000',
      maxMinutes: 10,
    });
    const other = await devAuth();
    const r5 = await call(other, 'POST', '/v1/paid-calls', { creatorId: c.id, minutes: 1 });
    expect(errOf(r5.body).code).toBe('CREATOR_UNAVAILABLE');
  }, 30_000);

  it('rejects a Session that does not match the booking', async () => {
    await boot(ON);
    const c = await creator();
    const fan = await devAuth();
    const b = await call(fan, 'POST', '/v1/paid-calls', { creatorId: c.id, minutes: 5 });
    const callId = b.body.callId as string;
    await fund(callId, { deposit: 1n });
    const r = await call(fan, 'POST', `/v1/paid-calls/${callId}/submitted`, { signature: SIG() });
    expect(r.status).toBe(400);
    expect(errOf(r.body).details.reason).toBe('tx_mismatch');
  }, 30_000);

  it('declined and unanswered calls are refunded once the accept window passes', async () => {
    await boot(ON);
    const ctx = buildContext();
    const c = await creator();
    const fan = await devAuth();
    const declined = await ringing(fan, c);
    const d = await call(c, 'POST', `/v1/paid-calls/${declined}/decline`);
    expect(d.body).toMatchObject({ status: 'refunding', endReason: 'declined' });
    // Too early for the program: nothing is sent.
    await sweepPaidCalls(ctx, new Date());
    expect(sent).not.toContain('refund');
    await sweepPaidCalls(ctx, new Date(Date.now() + 130_000));
    expect(sent.filter((s) => s === 'refund')).toHaveLength(1);
    const after = await call(fan, 'GET', `/v1/paid-calls/${declined}`);
    expect(after.body).toMatchObject({
      status: 'refunded',
      refundAmount: '2750000',
      creatorAmount: '0',
    });

    const c2 = await creator();
    const unanswered = await ringing(fan, c2);
    await sweepPaidCalls(ctx, new Date(Date.now() + 130_000)); // ringing -> refunding
    await sweepPaidCalls(ctx, new Date(Date.now() + 130_000)); // refunding -> refunded
    const u = await call(fan, 'GET', `/v1/paid-calls/${unanswered}`);
    expect(u.body).toMatchObject({ status: 'refunded', endReason: 'not_answered' });
    // An accept after the window is refused.
    const late = await call(c2, 'POST', `/v1/paid-calls/${unanswered}/accept`);
    expect(late.status).toBe(409);
  }, 30_000);

  it('the sweep ends a live call at its booked minutes and bills all of them', async () => {
    await boot(ON);
    const ctx = buildContext();
    const c = await creator();
    const fan = await devAuth();
    const id = await ringing(fan, c, 3);
    expect((await call(c, 'POST', `/v1/paid-calls/${id}/accept`)).body.status).toBe('live');
    await sweepPaidCalls(ctx, new Date(Date.now() + 3 * 60_000 + 1000));
    const r = await call(fan, 'GET', `/v1/paid-calls/${id}`);
    // 0.5 x 3 = 1.5 USDC to the creator, 0.15 fee, nothing back from 1.65.
    expect(r.body).toMatchObject({
      status: 'settled',
      endReason: 'max_reached',
      minutesUsed: 3,
      creatorAmount: '1500000',
      feeAmount: '150000',
      refundAmount: '0',
    });
    expect(sent).toContain('settle:180');
  }, 30_000);

  it('a signed LiveKit participant_left ends and settles the live call; unsigned is 400', async () => {
    await boot(ON);
    const ctx = buildContext();
    const c = await creator();
    const fan = await devAuth();
    const id = await ringing(fan, c, 3);
    await call(c, 'POST', `/v1/paid-calls/${id}/accept`);
    const body = JSON.stringify({
      event: 'participant_left',
      id: `EV_${uuidv7()}`,
      room: { name: `paid_call:${id}` },
      participant: { identity: c.id },
      createdAt: Math.floor(Date.now() / 1000),
    });
    const unsigned = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/livekit',
      headers: { 'content-type': 'application/webhook+json' },
      payload: body,
    });
    expect(unsigned.statusCode).toBe(400);
    expect((await call(fan, 'GET', `/v1/paid-calls/${id}`)).body.status).toBe('live');

    const at = new AccessToken(ctx.config.livekit.apiKey, ctx.config.livekit.apiSecret, {
      ttl: '5m',
    });
    at.sha256 = createHash('sha256').update(body).digest('base64');
    const signed = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/livekit',
      headers: { 'content-type': 'application/webhook+json', authorization: await at.toJwt() },
      payload: body,
    });
    expect(signed.statusCode, signed.body).toBe(200);
    const r = await call(fan, 'GET', `/v1/paid-calls/${id}`);
    expect(r.body).toMatchObject({ status: 'settled', endReason: 'participant_left' });
  }, 30_000);

  it('stores a reported signature only after it verifies on chain', async () => {
    await boot(ON);
    const c = await creator();
    const fan = await devAuth();
    const b = await call(fan, 'POST', '/v1/paid-calls', { creatorId: c.id, minutes: 5 });
    const callId = b.body.callId as string;
    await fund(callId);
    for (const [check, status, reason] of [
      ['not_found', 409, 'not_found_yet'],
      ['failed', 400, 'tx_mismatch'],
      ['mismatch', 400, 'tx_mismatch'],
    ] as const) {
      openCheck = check;
      const r = await call(fan, 'POST', `/v1/paid-calls/${callId}/submitted`, {
        signature: SIG(),
      });
      expect(r.status, check).toBe(status);
      expect(errOf(r.body).details.reason).toBe(reason);
    }
    const row = await pool.query(
      'SELECT open_signature, status FROM paid_calls WHERE call_id = $1',
      [callId],
    );
    expect(row.rows[0]).toEqual({ open_signature: null, status: 'awaiting_payment' });
    openCheck = 'ok';
    const ok = await call(fan, 'POST', `/v1/paid-calls/${callId}/submitted`, { signature: SIG() });
    expect(ok.body.status).toBe('ringing');
  }, 30_000);

  it('a busy creator: 409 call_in_progress at booking, and a funded second call is refunded', async () => {
    await boot(ON);
    const c = await creator();
    const fanA = await devAuth();
    const fanB = await devAuth();
    // Both book while the creator is free.
    const a = await call(fanA, 'POST', '/v1/paid-calls', { creatorId: c.id, minutes: 5 });
    const bCall = await call(fanB, 'POST', '/v1/paid-calls', { creatorId: c.id, minutes: 5 });
    expect(bCall.status).toBe(201);
    await fund(a.body.callId as string);
    await call(fanA, 'POST', `/v1/paid-calls/${a.body.callId}/submitted`, { signature: SIG() });
    // B funded too, but the creator is now being rung for A.
    const bId = bCall.body.callId as string;
    await fund(bId);
    const late = await call(fanB, 'POST', `/v1/paid-calls/${bId}/submitted`, { signature: SIG() });
    expect(late.status).toBe(409);
    expect(errOf(late.body).details).toMatchObject({ reason: 'call_in_progress', who: 'creator' });
    const bRow = await call(fanB, 'GET', `/v1/paid-calls/${bId}`);
    expect(bRow.body).toMatchObject({ status: 'refunding', endReason: 'creator_busy' });
    // A third fan cannot even book now.
    const fanC = await devAuth();
    const third = await call(fanC, 'POST', '/v1/paid-calls', { creatorId: c.id, minutes: 1 });
    expect(third.status).toBe(409);
    expect(errOf(third.body).details).toMatchObject({ reason: 'call_in_progress', who: 'creator' });
  }, 30_000);

  async function settlingCall(): Promise<{ id: string; fan: Authed }> {
    const c = await creator();
    const fan = await devAuth();
    const id = await ringing(fan, c, 3);
    await call(c, 'POST', `/v1/paid-calls/${id}/accept`);
    settleFails = true;
    const end = await call(fan, 'POST', `/v1/paid-calls/${id}/end`);
    expect(end.body.status).toBe('settling');
    settleFails = false;
    // The session closed by some other transaction (e.g. the fan's refund after the deadline).
    for (const k of [...sessions.keys()]) {
      if (sessions.get(k)!.status === 1) sessions.delete(k);
    }
    return { id, fan };
  }

  it('a closed session is never assumed settled: it follows the closing transaction', async () => {
    await boot(ON);
    const ctx = buildContext();
    const later = new Date(Date.now() + 30_000);

    const unknown = await settlingCall();
    closureResult = null;
    await sweepPaidCalls(ctx, later);
    expect((await call(unknown.fan, 'GET', `/v1/paid-calls/${unknown.id}`)).body).toMatchObject({
      status: 'closed_unknown',
      creatorAmount: '0',
      feeAmount: '0',
    });

    const refunded = await settlingCall();
    closureResult = { kind: 'refunded', signature: 'fanRefundSig', refundAmount: 1_650_000n };
    await sweepPaidCalls(ctx, later);
    expect((await call(refunded.fan, 'GET', `/v1/paid-calls/${refunded.id}`)).body).toMatchObject({
      status: 'refunded',
      creatorAmount: '0',
      refundAmount: '1650000',
      signatures: { refund: 'fanRefundSig', settle: null },
    });

    const settled = await settlingCall();
    closureResult = {
      kind: 'settled',
      signature: 'realSettleSig',
      creatorAmount: 500_000n,
      fee: 50_000n,
      refund: 1_100_000n,
      minutes: 1n,
    };
    await sweepPaidCalls(ctx, later);
    expect((await call(settled.fan, 'GET', `/v1/paid-calls/${settled.id}`)).body).toMatchObject({
      status: 'settled',
      creatorAmount: '500000',
      signatures: { settle: 'realSettleSig' },
    });
  }, 30_000);

  it('a refunding call whose session vanished without a refund tx is closed_unknown', async () => {
    await boot(ON);
    const ctx = buildContext();
    const c = await creator();
    const fan = await devAuth();
    const id = await ringing(fan, c);
    await call(c, 'POST', `/v1/paid-calls/${id}/decline`);
    sessions.clear();
    closureResult = null;
    await sweepPaidCalls(ctx, new Date(Date.now() + 130_000));
    expect((await call(fan, 'GET', `/v1/paid-calls/${id}`)).body).toMatchObject({
      status: 'closed_unknown',
      creatorAmount: '0',
    });
    expect(sent).not.toContain('refund');
  }, 30_000);

  it('booking needs usable USDC accounts for both sides (no authority-paid rent)', async () => {
    await boot(ON);
    const c = await creator();
    const fan = await devAuth();
    accountStates[fan.wallet] = 'missing';
    const r1 = await call(fan, 'POST', '/v1/paid-calls', { creatorId: c.id, minutes: 1 });
    expect(r1.status).toBe(400);
    expect(errOf(r1.body).details.reason).toBe('usdc_account_missing');
    accountStates = { [c.wallet]: 'unusable' };
    const r2 = await call(fan, 'POST', '/v1/paid-calls', { creatorId: c.id, minutes: 1 });
    expect(r2.status).toBe(403);
    expect(errOf(r2.body)).toMatchObject({
      code: 'CREATOR_UNAVAILABLE',
      details: { reason: 'creator_usdc_account_missing' },
    });
  }, 30_000);

  async function pastCalls(
    fanId: string,
    creatorId: string,
    n: number,
    o: { fanRent?: bigint; creatorRent?: bigint; paid?: boolean } = {},
  ) {
    for (let i = 0; i < n; i++) {
      await pool.query(
        `INSERT INTO paid_calls (call_id, fan_user_id, creator_user_id, fan_wallet, creator_wallet,
           session_id, session_pda, rate_per_min, max_minutes, fee_bps, deposit, status, pay_by,
           open_signature, authority_rent_lamports, fan_rent_lamports, creator_rent_lamports)
         VALUES ($1, $2, $3, 'w', 'w', $4, $5, 500000, 1, 1000, 550000, 'expired', now(), $6,
                 $7::bigint + $8::bigint, $7, $8)`,
        [
          uuidv7(),
          fanId,
          creatorId,
          1 + i,
          `pda-${uuidv7()}`,
          o.paid ? `sig-${uuidv7()}` : null,
          (o.fanRent ?? 0n).toString(),
          (o.creatorRent ?? 0n).toString(),
        ],
      );
    }
  }

  it('per-fan limits: bookings per hour, and per pair per day', async () => {
    await boot(ON);
    const fan = await devAuth();
    const a = await creator();
    const b = await creator();
    await pastCalls(fan.id, a.id, 3);
    await pastCalls(fan.id, b.id, 3);
    const c = await creator();
    const r = await call(fan, 'POST', '/v1/paid-calls', { creatorId: c.id, minutes: 1 });
    expect(r.status).toBe(429);
    expect(errOf(r.body).details).toMatchObject({ reason: 'paid_call_rate', window: 'hour' });

    const fan2 = await devAuth();
    await pastCalls(fan2.id, c.id, 4);
    const p = await call(fan2, 'POST', '/v1/paid-calls', { creatorId: c.id, minutes: 1 });
    expect(p.status).toBe(429);
    expect(errOf(p.body).details.reason).toBe('pair_call_rate');
  }, 30_000);

  it('a creator is not locked out by unpaid bookings; only funded calls count', async () => {
    await boot(ON);
    const c = await creator();
    const spammer = await devAuth();
    await pastCalls(spammer.id, c.id, 40); // unpaid, expired
    const fan = await devAuth();
    const ok = await call(fan, 'POST', '/v1/paid-calls', { creatorId: c.id, minutes: 1 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);

    const c2 = await creator();
    await pastCalls(spammer.id, c2.id, 40, { paid: true });
    const fan2 = await devAuth();
    const busy = await call(fan2, 'POST', '/v1/paid-calls', { creatorId: c2.id, minutes: 1 });
    expect(busy.status).toBe(429);
    expect(errOf(busy.body).details.reason).toBe('creator_call_rate');
  }, 30_000);

  it('rent is charged to whoever forced it: the requesting fan, not the creator they call', async () => {
    await boot(ON);
    const c = await creator();
    const other = await devAuth();
    // Other fans forced rent on calls to this creator: booking the creator still works.
    await pastCalls(other.id, c.id, 2, { fanRent: 2_039_280n });
    const fan = await devAuth();
    const ok = await call(fan, 'POST', '/v1/paid-calls', { creatorId: c.id, minutes: 1 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    // The fan who forced it is limited.
    const c2 = await creator();
    const limited = await call(other, 'POST', '/v1/paid-calls', { creatorId: c2.id, minutes: 1 });
    expect(limited.status).toBe(429);
    expect(errOf(limited.body).details.reason).toBe('account_recreations');
  }, 30_000);

  it('stops booking under the authority balance floor', async () => {
    await boot(ON);
    authorityLamports = 10_000_000n; // 0.01 SOL
    const c = await creator();
    const fan = await devAuth();
    const r = await call(fan, 'POST', '/v1/paid-calls', { creatorId: c.id, minutes: 1 });
    expect(r.status).toBe(503);
    expect(errOf(r.body).details).toMatchObject({
      capability: 'paidCalls',
      reason: 'authority_low',
    });
  }, 30_000);

  it('records the rent the authority paid on settle', async () => {
    await boot(ON);
    const c = await creator();
    const fan = await devAuth();
    const id = await ringing(fan, c, 3);
    await call(c, 'POST', `/v1/paid-calls/${id}/accept`);
    settleRent = 2_039_280n;
    expect((await call(fan, 'POST', `/v1/paid-calls/${id}/end`)).body.status).toBe('settled');
    const r = await pool.query(
      'SELECT authority_rent_lamports FROM paid_calls WHERE call_id = $1',
      [id],
    );
    expect(String(r.rows[0].authority_rent_lamports)).toBe('2039280');
  }, 30_000);

  it('failing refunds back off, then park as stuck; they never starve due rows', async () => {
    await boot(ON);
    const ctx = buildContext();
    const c = await creator();
    const fan = await devAuth();
    const id = await ringing(fan, c);
    await call(c, 'POST', `/v1/paid-calls/${id}/decline`);
    refundFails = true;
    let t = Date.now() + 130_000;
    await sweepPaidCalls(ctx, new Date(t));
    let row = (await pool.query('SELECT * FROM paid_calls WHERE call_id = $1', [id])).rows[0];
    expect(row).toMatchObject({
      status: 'refunding',
      attempts: 1,
      last_error: 'InvalidAccountData',
    });
    expect(row.next_attempt_at.getTime()).toBeGreaterThan(t);
    // Not due yet: the next pass leaves it alone.
    await sweepPaidCalls(ctx, new Date(t + 1000));
    row = (await pool.query('SELECT attempts FROM paid_calls WHERE call_id = $1', [id])).rows[0];
    expect(row.attempts).toBe(1);
    for (let n = 2; n <= MAX_SWEEP_ATTEMPTS; n++) {
      t += 31 * 60_000;
      await sweepPaidCalls(ctx, new Date(t));
    }
    row = (await pool.query('SELECT * FROM paid_calls WHERE call_id = $1', [id])).rows[0];
    expect(row).toMatchObject({ status: 'stuck', attempts: MAX_SWEEP_ATTEMPTS });
    expect(row.last_error).toContain('refunding');
    expect((await call(fan, 'GET', `/v1/paid-calls/${id}`)).body.status).toBe('stuck');
  }, 60_000);

  it('a pile of failing rows cannot block a live call from being ended on time', async () => {
    await boot(ON);
    const ctx = buildContext();
    // 210 refunding rows (more than the old 200-row window), older than everything, each
    // with a live session whose refund fails.
    const values: string[] = [];
    const params: unknown[] = [];
    const fanId = (await devAuth()).id;
    const creatorId = (await devAuth()).id;
    for (let i = 0; i < 210; i++) {
      const fanW = Keypair.generate().publicKey.toBase58();
      const creatorW = Keypair.generate().publicKey.toBase58();
      sessions.set(key({ fan: fanW, creator: creatorW, sessionId: 1n }), {
        sessionId: 1n,
        fan: fanW,
        creator: creatorW,
        ratePerMin: 500_000n,
        maxMinutes: 1,
        deposit: 550_000n,
        feeBps: 1000,
        openedAt: 0n,
        acceptedAt: 0n,
        settledAt: 0n,
        status: 0,
      });
      const o = params.length;
      values.push(
        `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, 1, $${o + 6}, 500000, 1, 1000, 550000,
          'refunding', now(), now() - interval '1 hour', now() - interval '1 day')`,
      );
      params.push(uuidv7(), fanId, creatorId, fanW, creatorW, `pda-${uuidv7()}`);
    }
    await pool.query(
      `INSERT INTO paid_calls (call_id, fan_user_id, creator_user_id, fan_wallet, creator_wallet,
         session_id, session_pda, rate_per_min, max_minutes, fee_bps, deposit, status, pay_by,
         opened_at, created_at)
       VALUES ${values.join(',')}`,
      params,
    );
    refundFails = true;
    const c = await creator();
    const fan = await devAuth();
    const id = await ringing(fan, c, 3);
    await call(c, 'POST', `/v1/paid-calls/${id}/accept`);
    await sweepPaidCalls(ctx, new Date(Date.now() + 3 * 60_000 + 1000));
    expect((await call(fan, 'GET', `/v1/paid-calls/${id}`)).body.status).toBe('settled');
    // The failing rows were tried in a bounded batch and backed off.
    const tried = await pool.query(
      `SELECT count(*)::int AS n FROM paid_calls WHERE fan_user_id = $1 AND attempts = 1`,
      [fanId],
    );
    expect(tried.rows[0].n).toBe(50);
    // Leave no failing rows behind for later sweeps (shared test database).
    await pool.query('DELETE FROM paid_calls WHERE fan_user_id = $1', [fanId]);
  }, 60_000);

  it('a failing settle is retried every pass and never parked (the refund deadline matters)', async () => {
    await boot(ON);
    const ctx = buildContext();
    const c = await creator();
    const fan = await devAuth();
    const id = await ringing(fan, c, 3);
    await call(c, 'POST', `/v1/paid-calls/${id}/accept`);
    settleFails = true;
    expect((await call(fan, 'POST', `/v1/paid-calls/${id}/end`)).body.status).toBe('settling');
    let t = Date.now() + 30_000;
    for (let n = 0; n < MAX_SWEEP_ATTEMPTS + 2; n++) {
      await sweepPaidCalls(ctx, new Date(t));
      t += 15_000;
    }
    const row = (await pool.query('SELECT * FROM paid_calls WHERE call_id = $1', [id])).rows[0];
    expect(row).toMatchObject({ status: 'settling', next_attempt_at: null });
    expect(row.attempts).toBe(MAX_SWEEP_ATTEMPTS + 2);
    settleFails = false;
    await sweepPaidCalls(ctx, new Date(t));
    expect((await call(fan, 'GET', `/v1/paid-calls/${id}`)).body.status).toBe('settled');
  }, 60_000);

  async function stuckRefund(): Promise<{ id: string; fan: Authed; t: number }> {
    const ctx = buildContext();
    const c = await creator();
    const fan = await devAuth();
    const id = await ringing(fan, c);
    await call(c, 'POST', `/v1/paid-calls/${id}/decline`);
    refundFails = true;
    let t = Date.now() + 130_000;
    for (let n = 1; n <= MAX_SWEEP_ATTEMPTS; n++) {
      await sweepPaidCalls(ctx, new Date(t));
      t += 31 * 60_000;
    }
    const row = (
      await pool.query('SELECT status, stuck_from FROM paid_calls WHERE call_id = $1', [id])
    ).rows[0];
    expect(row).toEqual({ status: 'stuck', stuck_from: 'refunding' });
    return { id, fan, t };
  }

  it('stuck recovery: a session closed meanwhile is reconciled; ops requeue retries the rest', async () => {
    await boot(ON);
    const ctx = buildContext();
    // 1. The fan refunded on chain themselves: the recheck reconciles it.
    const a = await stuckRefund();
    for (const [k, v] of sessions) if (v.fan === a.fan.wallet) sessions.delete(k);
    closureResult = { kind: 'refunded', signature: 'fanSelfRefund', refundAmount: 2_750_000n };
    await sweepPaidCalls(ctx, new Date(a.t + 11 * 60_000));
    expect((await call(a.fan, 'GET', `/v1/paid-calls/${a.id}`)).body).toMatchObject({
      status: 'refunded',
      signatures: { refund: 'fanSelfRefund' },
    });
    // 2. Still open on chain: requeue puts it back and the next pass refunds it.
    closureResult = null;
    const b = await stuckRefund();
    const out = await requeueStuckCalls(ctx, [b.id]);
    expect(out).toEqual({ requeued: [b.id], skipped: [] });
    const back = (
      await pool.query('SELECT status, attempts FROM paid_calls WHERE call_id = $1', [b.id])
    ).rows[0];
    expect(back).toEqual({ status: 'refunding', attempts: 0 });
    refundFails = false;
    await sweepPaidCalls(ctx, new Date(b.t));
    expect((await call(b.fan, 'GET', `/v1/paid-calls/${b.id}`)).body.status).toBe('refunded');
  }, 90_000);
});
