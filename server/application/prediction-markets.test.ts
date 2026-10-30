/**
 * Prediction Pit markets and settlement (unlock D3), against real Postgres
 * and Redis. Time is simulated (a fixed `now` in 2031, different every run);
 * the crypto source is a real local HTTP server speaking the Binance klines
 * shape, so nothing external is called.
 *
 *   - sim (and event) markets are sealed commit-reveal draws: the outcome
 *     rate is 1/2 per horizon and kind (simulation), ignores the coin's trend,
 *     the secret stays hidden until resolution and matches its commitment;
 *     a win pays 1.9x once, a loss nothing, a bad secret voids and refunds;
 *   - crypto markets take the strike and the result from the source, back
 *     off on 429, and void when the source never answers;
 *   - a legacy bet (no market) is refunded.
 */
import { createServer, type Server } from 'node:http';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { buildContext, _resetContextForTests, type AppContext } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { randomBytes } from 'node:crypto';
import {
  commitmentOf,
  drawOutcome,
  generateMarkets,
  toMarketView,
  type MarketRow,
} from './prediction-markets.js';
import { resolveDueMarkets, settleBets } from './prediction-resolver.js';
import { BinanceKlineSource, decimalToMicros } from './price-source.js';
import { predictionsConfig } from './prediction-config.js';

loadDotenv({ path: process.cwd() + '/.env' });
_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let ctx: AppContext;
// A whole hour in 2031, different per run so ids never collide with old runs.
const HOUR0 = Date.UTC(2031, 0, 1) + Math.floor(Math.random() * 8000) * 3_600_000;
const at = (sec: number): Date => new Date(HOUR0 + sec * 1000);
const coins: string[] = [];
const users: string[] = [];
const BIG_VOL = '9000000000000000';

async function newCoin(
  priceMicros: number,
  stage = 'graduated',
  playerLaunched = false,
): Promise<string> {
  const id = uuidv7();
  coins.push(id);
  await pool.query(
    `INSERT INTO coins (coin_id, ticker, name, stage, price_micros, mcap_cents, vol_5m_cents,
                        launched_at, hidden_arc, seed, player_launched)
     VALUES ($1, $2, 'Pred Test', $3, $4, 100000, $5, now(), '{}'::jsonb, 1, $6)`,
    [id, `PT${id.slice(-6).toUpperCase()}`, stage, priceMicros, BIG_VOL, playerLaunched],
  );
  return id;
}

async function newUser(cash: number): Promise<string> {
  const id = uuidv7();
  users.push(id);
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [id, `pred-${id}`]);
  await pool.query(`INSERT INTO balances (user_id, cash_cents) VALUES ($1, $2)`, [id, cash]);
  return id;
}

async function bet(
  userId: string,
  marketId: string,
  outcomeId: string,
  stake: number,
): Promise<string> {
  const id = uuidv7();
  await pool.query(
    `INSERT INTO predictions (prediction_id, user_id, outcome_id, stake_cents, status, horizon,
                              closes_at, created_at, market_id)
     SELECT $1, $2, $3, $4, 'open', horizon, resolves_at, opens_at, market_id
       FROM prediction_markets WHERE market_id = $5`,
    [id, userId, outcomeId, stake, marketId],
  );
  return id;
}

async function cash(userId: string): Promise<number> {
  const r = await pool.query<{ cash_cents: string }>(
    `SELECT cash_cents FROM balances WHERE user_id = $1`,
    [userId],
  );
  return Number(r.rows[0]?.cash_cents);
}

async function market(id: string): Promise<Record<string, unknown>> {
  const r = await pool.query(`SELECT * FROM prediction_markets WHERE market_id = $1`, [id]);
  return r.rows[0] as Record<string, unknown>;
}

beforeAll(async () => {
  ctx = buildContext();
  // Coins a crashed earlier run left behind would outrank this run's coins.
  const old = `SELECT coin_id FROM coins WHERE name = 'Pred Test'`;
  await pool.query(`DELETE FROM positions WHERE coin_id IN (${old})`);
  await pool.query(`DELETE FROM coins WHERE coin_id IN (${old})`);
});

afterAll(async () => {
  const like = `%:${Math.floor(HOUR0 / 1000)}%`;
  await pool.query(`DELETE FROM predictions WHERE user_id = ANY($1::uuid[])`, [users]);
  await pool.query(
    `DELETE FROM prediction_markets WHERE opens_at >= $1 AND opens_at < $2 OR market_id LIKE $3`,
    [at(-60), at(7 * 86_400), like],
  );
  await pool.query(`DELETE FROM positions WHERE coin_id = ANY($1::uuid[])`, [coins]);
  await pool.query(`DELETE FROM coins WHERE coin_id = ANY($1::uuid[])`, [coins]);
  await pool.end();
});

describe('decimalToMicros', () => {
  it('reads Binance decimal strings exactly', () => {
    expect(decimalToMicros('77516.62000000')).toBe(77_516_620_000n);
    expect(decimalToMicros('0.0000019')).toBe(1n);
    expect(decimalToMicros('95')).toBe(95_000_000n);
    expect(() => decimalToMicros('-1')).toThrow();
  });
});

describe('sealed draws are fair', () => {
  it('yes-rate is 50% within 3.5 points over 2000 markets per horizon and kind', () => {
    // Each market gets a fresh secret, as generateMarkets does. 2000 draws:
    // sigma = sqrt(0.25 / 2000) = 1.1 points, so 3.5 points is about 3 sigma.
    const kinds = ['sim:5m', 'sim:15m', 'sim:1h', 'event:event_rug_1h'];
    for (const kind of kinds) {
      let yes = 0;
      const n = 2000;
      for (let i = 0; i < n; i++) {
        const seed = randomBytes(32).toString('hex');
        if (drawOutcome(seed, `${kind}:${HOUR0 / 1000 + i * 60}`) === 'yes') yes++;
      }
      expect(Math.abs(yes / n - 0.5), kind).toBeLessThan(0.035);
    }
  });

  it('does not follow the coin: a coin that only goes up still resolves about half no', async () => {
    // 200 markets on one coin whose price rises every minute: the outcome
    // ignores the trend, so both outcomes stay near half.
    const up = await newCoin(1_000_000);
    await pool.query(`UPDATE coins SET vol_5m_cents = vol_5m_cents + 1 WHERE coin_id = $1`, [up]);
    let yes = 0;
    const ids: string[] = [];
    for (let i = 0; i < 200; i++) {
      const t = 30_000 + i * 60; // a fresh 5m period every minute
      await pool.query(`UPDATE coins SET price_micros = price_micros + 1000 WHERE coin_id = $1`, [
        up,
      ]);
      await generateMarkets(ctx, at(t + 1), null);
      ids.push(`sim:${up}:5m:${Math.floor(HOUR0 / 1000) + t}`);
    }
    while ((await resolveDueMarkets(ctx, at(30_000 + 200 * 60 + 600), null)) > 0);
    // Leave nothing due for later tests (the resolver takes 200 at a time).
    for (const id of ids) expect((await market(id)).status, id).toBe('resolved');
    for (const id of ids) if ((await market(id)).resolved_outcome_id === 'yes') yes++;
    expect(yes).toBeGreaterThan(60);
    expect(yes).toBeLessThan(140);
  });
});

describe('sim markets', () => {
  it('commit at open, reveal at resolution, pay 1.9x once', async () => {
    const coin = await newCoin(1_000_000);
    const now = at(2); // 2 s into the hour: every horizon's period starts now
    expect(await generateMarkets(ctx, now, null)).toBeGreaterThanOrEqual(3);
    expect(await generateMarkets(ctx, at(20), null)).toBe(0); // same periods: idempotent
    const startSec = Math.floor(HOUR0 / 1000);
    const id = `sim:${coin}:5m:${startSec}`;
    const m = await market(id);
    const basis = m.basis as { seed: string; commitment: string };
    expect(m).toMatchObject({
      kind: 'sim',
      status: 'open',
      question_key: 'sim_call',
      horizon: '5m',
    });
    expect(basis.commitment).toBe(commitmentOf(basis.seed));
    expect(m.params).toMatchObject({ coinId: coin, commitment: basis.commitment });
    expect(JSON.stringify(m.params)).not.toContain(basis.seed);
    expect((m.closes_at as Date).getTime()).toBe(HOUR0 + 45_000); // 45 s window
    expect((m.resolves_at as Date).getTime()).toBe(HOUR0 + 300_000);

    // The public view shows the commitment, never the secret, until resolved.
    const open = toMarketView(m as unknown as MarketRow, at(10));
    expect(open.fairness).toEqual({ commitment: basis.commitment, seed: null });

    const expected = drawOutcome(basis.seed, id);
    const winner = await newUser(0);
    const loser = await newUser(0);
    const w = await bet(winner, id, expected, 1_000);
    const l = await bet(loser, id, expected === 'yes' ? 'no' : 'yes', 1_000);
    await resolveDueMarkets(ctx, at(301), null);
    const done = await market(id);
    expect(done).toMatchObject({ status: 'resolved', resolved_outcome_id: expected });
    expect(toMarketView(done as unknown as MarketRow, at(302)).fairness).toEqual({
      commitment: basis.commitment,
      seed: basis.seed,
    });
    const [a, b] = await Promise.all([settleBets(ctx, at(302)), settleBets(ctx, at(302))]);
    expect(a + b).toBeGreaterThanOrEqual(2);
    const rows = await pool.query<{ prediction_id: string; status: string; payout_cents: string }>(
      `SELECT prediction_id, status, payout_cents FROM predictions WHERE prediction_id = ANY($1::uuid[])`,
      [[w, l]],
    );
    const by = new Map(rows.rows.map((r) => [r.prediction_id, r]));
    expect(by.get(w)).toMatchObject({ status: 'won', payout_cents: '1900' });
    expect(by.get(l)).toMatchObject({ status: 'lost', payout_cents: '0' });
    expect(await cash(winner)).toBe(1_900); // paid once, despite two concurrent sweeps
  });

  it('voids (refunds) a sealed market whose secret does not match its commitment', async () => {
    const coin = await newCoin(1_000_000);
    await generateMarkets(ctx, at(3600 + 1), null);
    const id = `sim:${coin}:5m:${Math.floor(HOUR0 / 1000) + 3600}`;
    await pool.query(
      `UPDATE prediction_markets SET basis = jsonb_set(basis, '{seed}', to_jsonb($2::text)) WHERE market_id = $1`,
      [id, 'ab'.repeat(32)],
    );
    const u = await newUser(0);
    const p = await bet(u, id, 'yes', 700);
    await resolveDueMarkets(ctx, at(3600 + 301), null);
    expect((await market(id)).status).toBe('void');
    await settleBets(ctx, at(3600 + 302));
    const r = await pool.query(
      `SELECT status, payout_cents FROM predictions WHERE prediction_id = $1`,
      [p],
    );
    expect(r.rows[0]).toEqual({ status: 'cancelled', payout_cents: '700' });
    expect(await cash(u)).toBe(700);
  });
});

describe('crypto markets', () => {
  let server: Server;
  let base = '';
  let mode: 'ok' | 'limited' | 'down' = 'ok';
  let calls = 0;
  const startSec = Math.floor(HOUR0 / 1000) + 10_800;

  beforeAll(async () => {
    server = createServer((req, res) => {
      calls++;
      const u = new URL(req.url ?? '/', 'http://x');
      if (mode === 'limited') {
        res.writeHead(429, { 'retry-after': '120' }).end('{}');
        return;
      }
      if (mode === 'down') {
        res.writeHead(451).end('{}');
        return;
      }
      const t = Number(u.searchParams.get('startTime'));
      const open = u.searchParams.get('symbol') === 'BTCUSDT' ? '100000.5' : '200.25';
      const close =
        t === startSec * 1000
          ? open
          : u.searchParams.get('symbol') === 'BTCUSDT'
            ? '101000'
            : '150';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([[t, open, '0', '0', close, '1', t + 59_999, '0', 1, '0', '0', '0']]));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('records the strike from the source, resolves from the closing candle, backs off on 429', async () => {
    const source = new BinanceKlineSource(ctx, base);
    await ctx.redis.main.del(`predictions:source:backoff:${source.ref}`);
    await generateMarkets(ctx, at(10_800 + 5), source);
    const btc = `crypto:BTCUSDT:${startSec}`;
    const sol = `crypto:SOLUSDT:${startSec}`;
    expect(await market(btc)).toMatchObject({
      kind: 'crypto',
      horizon: 'daily',
      strike_micros: '100000500000',
      source: { type: 'binance', ref: source.ref },
    });
    const resolveAt = 10_800 + predictionsConfig().crypto.horizonSec;

    mode = 'limited';
    await resolveDueMarkets(ctx, at(resolveAt + 1), source);
    expect((await market(btc)).status).toBe('open'); // not decided: waits for the source
    const before = calls;
    await ctx.redis.main.del(`predictions:resolve:${btc}`, `predictions:resolve:${sol}`);
    await resolveDueMarkets(ctx, at(resolveAt + 40), source); // backing off: no call
    expect(calls).toBe(before);

    mode = 'ok';
    await ctx.redis.main.del(
      `predictions:source:backoff:${source.ref}`,
      `predictions:resolve:${btc}`,
      `predictions:resolve:${sol}`,
    );
    await resolveDueMarkets(ctx, at(resolveAt + 60), source);
    expect(await market(btc)).toMatchObject({
      resolved_outcome_id: 'yes',
      resolved_value_micros: '101000000000',
    });
    expect(await market(sol)).toMatchObject({
      resolved_outcome_id: 'no',
      resolved_value_micros: '150000000',
    });
  });

  it('opens nothing when the source is down, and voids open markets after the grace', async () => {
    mode = 'down';
    const source = new BinanceKlineSource(ctx, base);
    const day = 10_800 + 3600;
    await generateMarkets(ctx, at(day + 5), source);
    expect(await market(`crypto:BTCUSDT:${startSec + 3600}`)).toBeUndefined();
    // A market from earlier, with the source now switched off entirely.
    const id = `crypto:BTCUSDT:${startSec}`;
    await pool.query(
      `UPDATE prediction_markets SET status = 'closed', resolved_outcome_id = NULL WHERE market_id = $1`,
      [id],
    );
    const end = 10_800 + predictionsConfig().crypto.horizonSec;
    await resolveDueMarkets(ctx, at(end + 60), null);
    expect((await market(id)).status).toBe('closed'); // still inside the grace
    await resolveDueMarkets(ctx, at(end + predictionsConfig().resolveGraceSec + 1), null);
    expect((await market(id)).status).toBe('void');
  });
});

describe('legacy bets', () => {
  it('refunds a bet with no market once its closes_at passed', async () => {
    const u = await newUser(0);
    const id = uuidv7();
    await pool.query(
      `INSERT INTO predictions (prediction_id, user_id, outcome_id, stake_cents, status, horizon, closes_at, created_at)
       VALUES ($1, $2, 'btc-24h-up', 400, 'open', '5m', now() - interval '1 minute', now() - interval '10 minutes')`,
      [id, u],
    );
    await settleBets(ctx, new Date());
    const r = await pool.query(
      `SELECT status, payout_cents FROM predictions WHERE prediction_id = $1`,
      [id],
    );
    expect(r.rows[0]).toEqual({ status: 'cancelled', payout_cents: '400' });
    expect(await cash(u)).toBe(400);
  });
});
