/**
 * Prediction Pit over HTTP (unlock D3): the market list and bets behind the
 * `predict` app capability, every bet error (unknown_outcome,
 * stake_out_of_range, market_closed, NOT_FOUND, AGE_REQUIRED,
 * INSUFFICIENT_CASH, daily_stake_cap), idempotent replay, the history shape
 * and the retired POST /v1/predictions (410).
 *
 * Markets are inserted directly (the worker is tested elsewhere).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApi, errCode, errDetails, type TestApi, type TestPlayer } from './http-test-kit.js';
import { createDb } from '../shared/db/pool.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { predictionsConfig } from '../application/prediction-config.js';

let api: TestApi;
const markets: string[] = [];
const players: string[] = [];
const db = (): ReturnType<typeof createDb> => createDb();

async function newMarket(
  opts: { closesInSec: number; status?: string } = { closesInSec: 120 },
): Promise<string> {
  const id = `test:${uuidv7()}`;
  markets.push(id);
  const now = Date.now();
  await db().withConnection((c) =>
    c.query(
      `INSERT INTO prediction_markets
         (market_id, kind, question_key, params, outcomes, horizon, opens_at, closes_at, resolves_at,
          source, payout_bps, min_stake_cents, max_stake_cents, status, strike_micros)
       VALUES ($1, 'sim', 'sim_higher', '{"ticker":"TEST","strikeMicros":"1000"}',
               '[{"outcomeId":"yes","labelKey":"predict.outcome.yes"},{"outcomeId":"no","labelKey":"predict.outcome.no"}]',
               '5m', $2, $3, $4, '{"type":"sim","ref":"test"}', 19000, 100, 50000, $5, 1000)`,
      [
        id,
        new Date(now - 60_000),
        new Date(now + opts.closesInSec * 1000),
        new Date(now + Math.max(opts.closesInSec, 1) * 1000 + 240_000),
        opts.status ?? 'open',
      ],
    ),
  );
  return id;
}

async function adult(cash: number): Promise<TestPlayer> {
  const p = await api.player();
  players.push(p.sub);
  await db().withConnection(async (c) => {
    await c.query(
      `INSERT INTO characters (id, user_id, alias, look, tribe_id, trait_ids, dream_id, home_id, age_confirmed_at)
       VALUES ($1, $2, $3, '{}'::jsonb, 'degen', '{}', 'dream', 'parents_basement', now())
       ON CONFLICT (user_id) DO UPDATE SET age_confirmed_at = now()`,
      [uuidv7(), p.sub, `pred_${p.sub.slice(-12)}`],
    );
    await c.query(
      `INSERT INTO balances (user_id, cash_cents) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET cash_cents = $2`,
      [p.sub, cash],
    );
  });
  return p;
}

async function cashOf(userId: string): Promise<number> {
  const r = await db().withConnection((c) =>
    c.query<{ cash_cents: string }>(`SELECT cash_cents FROM balances WHERE user_id = $1`, [userId]),
  );
  return Number(r.rows[0]?.cash_cents);
}

const betUrl = (id: string): string => `/v1/predictions/markets/${encodeURIComponent(id)}/bets`;

describe('prediction pit', () => {
  beforeAll(async () => {
    api = await bootApi('predict', { LIVE_PHASE: '6' });
  }, 30_000);
  afterAll(async () => {
    await db().withConnection(async (c) => {
      await c.query(`DELETE FROM predictions WHERE user_id = ANY($1::uuid[])`, [players]);
      await c.query(`DELETE FROM prediction_markets WHERE market_id = ANY($1::text[])`, [markets]);
    });
    await api.stop();
  }, 30_000);

  it('lists open markets with the contract fields and pages them', async () => {
    const id = await newMarket();
    const p = await api.player();
    const r = await api.call(p, 'GET', '/v1/predictions/markets?status=open');
    expect(r.status).toBe(200);
    const list = r.body.markets as Array<Record<string, unknown>>;
    const m = list.find((x) => x.marketId === id);
    expect(m).toMatchObject({
      kind: 'sim',
      questionKey: 'sim_higher',
      params: { ticker: 'TEST', strikeMicros: '1000' },
      outcomes: [
        { outcomeId: 'yes', labelKey: 'predict.outcome.yes' },
        { outcomeId: 'no', labelKey: 'predict.outcome.no' },
      ],
      horizon: '5m',
      payoutBps: 19000,
      minStakeCents: 100,
      maxStakeCents: 50000,
      status: 'open',
      resolvedOutcomeId: null,
      source: { type: 'sim', ref: 'test' },
    });
    expect(r.body).toHaveProperty('nextCursor');
    expect((await api.call(p, 'GET', '/v1/predictions/markets?status=nope')).status).toBe(400);
    expect((await api.call(p, 'GET', '/v1/predictions/markets?cursor=%%%')).status).toBe(400);
  });

  it('places a bet: debits once, replays the same key, shows in history', async () => {
    const id = await newMarket();
    const p = await adult(10_000);
    const headers = { authorization: `Bearer ${p.accessToken}`, 'idempotency-key': uuidv7() };
    const payload = { outcomeId: 'yes', stakeCents: 1_000 };
    const a = await api.app.inject({ method: 'POST', url: betUrl(id), headers, payload });
    const b = await api.app.inject({ method: 'POST', url: betUrl(id), headers, payload });
    expect(a.statusCode, a.body).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.json()).toEqual(a.json());
    expect(a.json()).toMatchObject({
      marketId: id,
      outcomeId: 'yes',
      stakeCents: 1_000,
      potentialPayoutCents: 1_900,
      status: 'open',
    });
    expect(await cashOf(p.sub)).toBe(9_000);
    const hist = await api.call(p, 'GET', '/v1/predictions');
    expect(Array.isArray(hist.body)).toBe(true);
    expect((hist.body as unknown as Array<Record<string, unknown>>)[0]).toMatchObject({
      marketId: id,
      questionKey: 'sim_higher',
      params: { ticker: 'TEST', strikeMicros: '1000' },
      outcomeId: 'yes',
      status: 'open',
      resolvedOutcomeId: null,
      payoutCents: null,
    });
  });

  it('refuses every invalid bet with the contract error and charges nothing', async () => {
    const id = await newMarket();
    const p = await adult(500);
    const unknown = await api.call(p, 'POST', betUrl(id), { outcomeId: 'maybe', stakeCents: 100 });
    expect(unknown.status).toBe(400);
    expect(errDetails(unknown).reason).toBe('unknown_outcome');
    const small = await api.call(p, 'POST', betUrl(id), { outcomeId: 'yes', stakeCents: 99 });
    expect(errDetails(small)).toMatchObject({ reason: 'stake_out_of_range', min: 100, max: 50000 });
    const big = await api.call(p, 'POST', betUrl(id), { outcomeId: 'yes', stakeCents: 50_001 });
    expect(errDetails(big).reason).toBe('stake_out_of_range');
    const broke = await api.call(p, 'POST', betUrl(id), { outcomeId: 'yes', stakeCents: 600 });
    expect(broke.status).toBe(402);
    expect(errCode(broke)).toBe('INSUFFICIENT_CASH');
    const missing = await api.call(p, 'POST', betUrl('test:nope'), {
      outcomeId: 'yes',
      stakeCents: 100,
    });
    expect(missing.status).toBe(404);
    const closed = await newMarket({ closesInSec: -1 });
    const late = await api.call(p, 'POST', betUrl(closed), { outcomeId: 'yes', stakeCents: 100 });
    expect(late.status).toBe(409);
    expect(errDetails(late).reason).toBe('market_closed');
    const extra = await api.call(p, 'POST', betUrl(id), {
      outcomeId: 'yes',
      stakeCents: 100,
      x: 1,
    });
    expect(extra.status).toBe(400);
    expect(await cashOf(p.sub)).toBe(500);

    const kid = await api.player(); // no 18+ confirmation
    const age = await api.call(kid, 'POST', betUrl(id), { outcomeId: 'yes', stakeCents: 100 });
    expect(age.status).toBe(403);
    expect(errCode(age)).toBe('AGE_REQUIRED');
  });

  it('enforces the daily stake cap with 429 RATE_LIMITED daily_stake_cap', async () => {
    const cfg = predictionsConfig();
    const id = await newMarket();
    const p = await adult(cfg.dailyStakeCapCents + 10_000);
    let placed = 0;
    while (placed + cfg.maxStakeCents <= cfg.dailyStakeCapCents) {
      const r = await api.call(p, 'POST', betUrl(id), {
        outcomeId: 'no',
        stakeCents: cfg.maxStakeCents,
      });
      expect(r.status).toBe(201);
      placed += cfg.maxStakeCents;
    }
    const over = await api.call(p, 'POST', betUrl(id), {
      outcomeId: 'no',
      stakeCents: cfg.maxStakeCents,
    });
    expect(over.status).toBe(429);
    expect(errCode(over)).toBe('RATE_LIMITED');
    expect(errDetails(over)).toMatchObject({
      reason: 'daily_stake_cap',
      capCents: cfg.dailyStakeCapCents,
    });
    expect(typeof errDetails(over).resetAt).toBe('string');
  });

  it('retires POST /v1/predictions with 410 GONE use_market_bets', async () => {
    const p = await api.player();
    const r = await api.call(p, 'POST', '/v1/predictions', {
      outcomeId: 'btc-24h-up',
      stakeCents: 100,
      horizon: '5m',
    });
    expect(r.status).toBe(410);
    expect(errCode(r)).toBe('GONE');
    expect(errDetails(r).reason).toBe('use_market_bets');
  });
});

describe('prediction pit gate', () => {
  it('answers 503 CAPABILITY_OFF on markets and bets while predict is off', async () => {
    const off = await bootApi('', { LIVE_PHASE: '6' });
    try {
      const p = await off.player();
      const list = await off.call(p, 'GET', '/v1/predictions/markets');
      expect(list.status).toBe(503);
      expect(errDetails(list)).toEqual({ capability: 'predict' });
      const bet = await off.call(p, 'POST', betUrl('x'), { outcomeId: 'yes', stakeCents: 100 });
      expect(bet.status).toBe(503);
      // History stays readable while dark.
      expect((await off.call(p, 'GET', '/v1/predictions')).status).toBe(200);
    } finally {
      await off.stop();
    }
  });
});
