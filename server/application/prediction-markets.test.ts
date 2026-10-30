/**
 * Prediction Pit markets and settlement (unlock D3), against real Postgres
 * and Redis. Time is simulated (a fixed `now` in 2031, different every run);
 * the crypto source is a real local HTTP server speaking the Binance klines
 * shape, so nothing external is called.
 *
 *   - the generator opens sim markets on the top coins with the strike
 *     recorded at open, idempotently, and closes them when the window ends;
 *   - outcomes come from the recorded snapshot at resolvesAt; a win pays
 *     1.9x once, a loss nothing, a void market refunds;
 *   - event markets resolve from the coin set recorded at open;
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
import { generateMarkets } from './prediction-markets.js';
import { resolveDueMarkets, settleBets } from './prediction-resolver.js';
import { BinanceKlineSource, decimalToMicros } from './price-source.js';
import { predictionsConfig } from './prediction-config.js';
import { launchpadBuy } from './launchpad.js';
import { executeTrade } from './terminal-cafe.js';

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
  await pool.query(`DELETE FROM prediction_price_snapshots WHERE coin_id = ANY($1::uuid[])`, [
    coins,
  ]);
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

describe('sim markets', () => {
  it('opens on the top coins with the strike at open, once, and settles from the snapshot', async () => {
    const up = await newCoin(1_000_000);
    const down = await newCoin(2_000_000);
    const now = at(2); // 2 s into the hour: every horizon's period starts now
    const opened = await generateMarkets(ctx, now, null);
    expect(opened).toBeGreaterThanOrEqual(6);
    expect(await generateMarkets(ctx, at(20), null)).toBe(0); // same periods: idempotent

    const startSec = Math.floor(HOUR0 / 1000);
    const upId = `sim:${up}:5m:${startSec}`;
    const m = await market(upId);
    expect(m).toMatchObject({
      kind: 'sim',
      status: 'open',
      strike_micros: '1000000',
      horizon: '5m',
    });
    expect((m.closes_at as Date).getTime()).toBe(HOUR0 + 45_000); // 45 s window
    expect((m.resolves_at as Date).getTime()).toBe(HOUR0 + 300_000);
    expect(m.params).toMatchObject({ coinId: up, strikeMicros: '1000000' });

    // Bets, then prices move; the worker snapshots at the resolves_at minute.
    const yes = await newUser(0);
    const no = await newUser(0);
    const yesBet = await bet(yes, upId, 'yes', 1_000);
    const noBet = await bet(no, upId, 'no', 1_000);
    const downId = `sim:${down}:5m:${startSec}`;
    const downBet = await bet(yes, downId, 'yes', 500);
    await generateMarkets(ctx, at(90), null);
    expect((await market(upId)).status).toBe('closed');
    await pool.query(`UPDATE coins SET price_micros = 1500000 WHERE coin_id = $1`, [up]);
    await pool.query(`UPDATE coins SET price_micros = 1900000 WHERE coin_id = $1`, [down]);
    await generateMarkets(ctx, at(300), null);
    // A later price change must not matter: the value is the recorded one.
    await pool.query(`UPDATE coins SET price_micros = 1 WHERE coin_id = $1`, [up]);

    expect(await resolveDueMarkets(ctx, at(301), null)).toBeGreaterThanOrEqual(2);
    expect(await market(upId)).toMatchObject({
      status: 'resolved',
      resolved_outcome_id: 'yes',
      resolved_value_micros: '1500000',
    });
    expect((await market(downId)).resolved_outcome_id).toBe('no');

    const [a, b] = await Promise.all([settleBets(ctx, at(302)), settleBets(ctx, at(302))]);
    expect(a + b).toBeGreaterThanOrEqual(3);
    expect(await settleBets(ctx, at(303))).toBe(0);
    const rows = await pool.query<{ prediction_id: string; status: string; payout_cents: string }>(
      `SELECT prediction_id, status, payout_cents FROM predictions WHERE prediction_id = ANY($1::uuid[])`,
      [[yesBet, noBet, downBet]],
    );
    const by = new Map(rows.rows.map((r) => [r.prediction_id, r]));
    expect(by.get(yesBet)).toMatchObject({ status: 'won', payout_cents: '1900' });
    expect(by.get(noBet)).toMatchObject({ status: 'lost', payout_cents: '0' });
    expect(by.get(downBet)).toMatchObject({ status: 'lost', payout_cents: '0' });
    expect(await cash(yes)).toBe(1_900); // paid once, despite two concurrent sweeps
    expect(await cash(no)).toBe(0);
  });

  it('voids a market whose snapshot is missing past the grace, and refunds', async () => {
    const coin = await newCoin(5_000_000);
    const startSec = Math.floor(HOUR0 / 1000) + 3600;
    await generateMarkets(ctx, at(3600 + 1), null);
    const id = `sim:${coin}:5m:${startSec}`;
    const u = await newUser(0);
    const p = await bet(u, id, 'yes', 700);
    // No generator run at resolves_at, and the resolver comes too late.
    const late = at(3600 + 300 + predictionsConfig().snapshotGraceSec + 1);
    await resolveDueMarkets(ctx, late, null);
    expect((await market(id)).status).toBe('void');
    await settleBets(ctx, late);
    const r = await pool.query(
      `SELECT status, payout_cents FROM predictions WHERE prediction_id = $1`,
      [p],
    );
    expect(r.rows[0]).toEqual({ status: 'cancelled', payout_cents: '700' });
    expect(await cash(u)).toBe(700);
  });
});

describe('event markets', () => {
  it('resolve from stage changes after the window closed', async () => {
    const c1 = await newCoin(1_000_000);
    const base = 7200;
    await generateMarkets(ctx, at(base + 1), null);
    const startSec = Math.floor(HOUR0 / 1000) + base;
    const rug = `event:event_rug_1h:${startSec}`;
    expect((await market(rug)).basis).toMatchObject({
      coinIds: expect.arrayContaining([c1]),
      openStages: expect.objectContaining({ [c1]: 'graduated' }),
    });
    // The sweep right after closesAt records each coin's stage.
    const closesSec = predictionsConfig().event.betWindowSec;
    await resolveDueMarkets(ctx, at(base + closesSec + 3), null);
    expect((await market(rug)).basis).toMatchObject({ closedStages: { [c1]: 'graduated' } });
    await pool.query(`UPDATE coins SET stage = 'dead' WHERE coin_id = $1`, [c1]);
    await newCoin(1_000_000); // not in the set: does not count
    await resolveDueMarkets(ctx, at(base + 3600), null);
    expect(await market(rug)).toMatchObject({ status: 'resolved', resolved_outcome_id: 'yes' });
  });

  it('a rug before the window closed does not resolve the market', async () => {
    const base = 14_400;
    const early = await newCoin(1_000_000);
    await generateMarkets(ctx, at(base + 1), null);
    const rug = `event:event_rug_1h:${Math.floor(HOUR0 / 1000) + base}`;
    expect((await market(rug)).basis).toMatchObject({ coinIds: expect.arrayContaining([early]) });
    // Rugs while bets are still open (a bettor could have seen it).
    await pool.query(`UPDATE coins SET stage = 'dead' WHERE coin_id = $1`, [early]);
    await resolveDueMarkets(ctx, at(base + predictionsConfig().event.betWindowSec + 2), null);
    await resolveDueMarkets(ctx, at(base + 3600), null);
    expect(await market(rug)).toMatchObject({ status: 'resolved', resolved_outcome_id: 'no' });
  });

  it('voids when nothing recorded the close in time', async () => {
    const base = 18_000;
    await newCoin(1_000_000);
    await generateMarkets(ctx, at(base + 1), null);
    const rug = `event:event_rug_1h:${Math.floor(HOUR0 / 1000) + base}`;
    await resolveDueMarkets(ctx, at(base + 3600), null); // first sweep only at resolution
    expect((await market(rug)).status).toBe('void');
  });
});

describe('sim markets and player trades', () => {
  it('use only engine-priced coins, so no trade can push the settling price', async () => {
    const base = 21_600;
    const onCurve = await newCoin(1_000_000, 'new'); // launchpad buys move its price
    const playerCoin = await newCoin(1_000_000, 'graduated', true);
    const house = await newCoin(1_000_000, 'graduated');
    await generateMarkets(ctx, at(base + 2), null);
    const s = Math.floor(HOUR0 / 1000) + base;
    expect(await market(`sim:${onCurve}:5m:${s}`)).toBeUndefined();
    expect(await market(`sim:${playerCoin}:5m:${s}`)).toBeUndefined();
    // A launchpad buy, the only player path that writes a price, is refused past the curve.
    const trader = await newUser(1_000_000);
    await expect(launchpadBuy(ctx, trader, house, 50_000, 10_000)).rejects.toMatchObject({
      details: { reason: 'coin already past launchpad' },
    });
    // A Terminal Cafe buy executes at the quote and leaves the price alone.
    await executeTrade(ctx, {
      userId: trader,
      coinId: house,
      side: 'buy',
      cashCents: 50_000,
      maxSlippageBps: 10_000,
    }).catch(() => undefined);
    const price = await pool.query<{ price_micros: string }>(
      `SELECT price_micros FROM coins WHERE coin_id = $1`,
      [house],
    );
    expect(price.rows[0]!.price_micros).toBe('1000000');
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
