/**
 * Prediction Pit markets (unlock D3): generation and the public list.
 *
 *   GET /v1/predictions/markets?status=open&cursor=
 *
 * The market worker (server/workers/prediction-markets.ts) calls
 * `generateMarkets` once a minute. It opens:
 *   - `sim`: "is $TICKER higher at resolvesAt than now?" on the top in-game
 *     coins by 5-minute volume, at the 5m / 15m / 1h horizons. Only house
 *     coins past the bonding curve (`final`/`graduated`, not player-launched):
 *     their price is written only by the market engine's drift. Terminal Cafe
 *     trades execute at the quote without moving it, and the launchpad buy
 *     that does move a price only works on `new` coins. So no player can push
 *     the price a sim market settles on;
 *   - `event`: "will any of these coins rug in the next hour?" over the same
 *     kind of coins (`event_graduate_1h` exists but is off by default: anyone
 *     can push a `new` coin to graduation with launchpad buys). The coin set
 *     and each coin's stage are recorded at open, and each coin's stage again
 *     right after `closesAt` (`closedStages`); only changes after that count;
 *   - `crypto`: "is BTC (SOL) higher in 24 h than now?" from the configured
 *     reference source, only when PREDICTIONS_CRYPTO_SOURCE is not `off`.
 *
 * Every market records its strike (and, for events, the coin set) at the
 * moment it opens, and takes bets only for a short window after that
 * (`betWindowSec`), so nobody can watch most of the move and then bet on it
 * at fixed odds. New markets of each kind open every `everySec`, so one is
 * usually taking bets. Ids are deterministic per period, so two worker
 * replicas insert the same market once (`ON CONFLICT DO NOTHING`).
 *
 * The worker also writes the minute price snapshot of every coin with an
 * unresolved `sim` market (the `sim` resolver reads it), marks markets whose
 * window ended `closed`, and prunes old unbet markets and snapshots.
 */
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ValidationFailedError } from '../shared/domain/errors.js';
import type { AppContext } from './context.js';
import { HORIZON_SEC, predictionsConfig, type Horizon } from './prediction-config.js';
import type { ReferencePriceSource } from './price-source.js';

export type MarketKind = 'sim' | 'crypto' | 'event' | 'mirror';
export type MarketStatus = 'open' | 'closed' | 'resolved' | 'void';

/** The two outcomes every current market has. */
export const YES_NO = [
  { outcomeId: 'yes', labelKey: 'predict.outcome.yes' },
  { outcomeId: 'no', labelKey: 'predict.outcome.no' },
] as const;

export interface MarketView {
  readonly marketId: string;
  readonly kind: MarketKind;
  readonly questionKey: string;
  readonly params: Record<string, string>;
  readonly outcomes: ReadonlyArray<{ outcomeId: string; labelKey: string }>;
  readonly horizon: Horizon;
  readonly opensAt: string;
  readonly closesAt: string;
  readonly resolvesAt: string;
  readonly payoutBps: number;
  readonly minStakeCents: number;
  readonly maxStakeCents: number;
  readonly status: MarketStatus;
  readonly resolvedOutcomeId: string | null;
  readonly source: { type: 'sim' | 'binance' | 'polymarket'; ref: string };
}

export interface MarketRow {
  market_id: string;
  kind: MarketKind;
  question_key: string;
  params: Record<string, string>;
  outcomes: Array<{ outcomeId: string; labelKey: string }>;
  horizon: Horizon;
  opens_at: Date;
  closes_at: Date;
  resolves_at: Date;
  source: { type: 'sim' | 'binance' | 'polymarket'; ref: string };
  payout_bps: number;
  min_stake_cents: string;
  max_stake_cents: string;
  status: MarketStatus;
  strike_micros: string | null;
  basis: {
    coinIds?: string[];
    symbol?: string;
    openStages?: Record<string, string>;
    closedStages?: Record<string, string>;
    closedAt?: string;
  };
  resolved_outcome_id: string | null;
}

/** The stages that make an event question `yes`. */
export function eventTargetStages(questionKey: string): string[] {
  return questionKey === 'event_rug_1h' ? ['dead'] : ['final', 'graduated'];
}

/** Coins whose price only the engine moves: house coins past the curve. */
const ENGINE_ONLY_COINS = `stage IN ('final', 'graduated') AND NOT player_launched AND creator_id IS NULL`;

export const MARKET_COLUMNS = `market_id, kind, question_key, params, outcomes, horizon, opens_at,
  closes_at, resolves_at, source, payout_bps, min_stake_cents, max_stake_cents, status,
  strike_micros, basis, resolved_outcome_id`;

/**
 * The wire shape of a market row.
 * @param r - The row.
 * @param now - The current time (an open market past its window reads `closed`).
 * @returns The contract `PredictionMarket`.
 */
export function toMarketView(r: MarketRow, now: Date): MarketView {
  const status = r.status === 'open' && r.closes_at <= now ? 'closed' : r.status;
  return {
    marketId: r.market_id,
    kind: r.kind,
    questionKey: r.question_key,
    params: r.params,
    outcomes: r.outcomes,
    horizon: r.horizon,
    opensAt: r.opens_at.toISOString(),
    closesAt: r.closes_at.toISOString(),
    resolvesAt: r.resolves_at.toISOString(),
    payoutBps: r.payout_bps,
    minStakeCents: Number(r.min_stake_cents),
    maxStakeCents: Number(r.max_stake_cents),
    status,
    resolvedOutcomeId: r.resolved_outcome_id,
    source: r.source,
  };
}

interface NewMarket {
  id: string;
  kind: MarketKind;
  questionKey: string;
  params: Record<string, string>;
  horizon: Horizon;
  opensAt: Date;
  closesAt: Date;
  resolvesAt: Date;
  source: { type: 'sim' | 'binance'; ref: string };
  strikeMicros: bigint | null;
  basis: Record<string, unknown>;
}

async function insertMarket(c: PoolClient, m: NewMarket): Promise<boolean> {
  const cfg = predictionsConfig();
  const r = await c.query(
    `INSERT INTO prediction_markets
       (market_id, kind, question_key, params, outcomes, horizon, opens_at, closes_at, resolves_at,
        source, payout_bps, min_stake_cents, max_stake_cents, strike_micros, basis)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (market_id) DO NOTHING`,
    [
      m.id,
      m.kind,
      m.questionKey,
      JSON.stringify(m.params),
      JSON.stringify(YES_NO),
      m.horizon,
      m.opensAt,
      m.closesAt,
      m.resolvesAt,
      JSON.stringify(m.source),
      cfg.payoutBps,
      cfg.minStakeCents,
      cfg.maxStakeCents,
      m.strikeMicros?.toString() ?? null,
      JSON.stringify(m.basis),
    ],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Period start (seconds) and the window that is still left to bet in it. */
function period(
  nowMs: number,
  everySec: number,
  betWindowSec: number,
): { startSec: number; closesAt: Date } | null {
  const nowSec = Math.floor(nowMs / 1000);
  const startSec = Math.floor(nowSec / everySec) * everySec;
  const closesAt = new Date((startSec + betWindowSec) * 1000);
  // A late run still opens the market, but only with a real window left.
  return closesAt.getTime() - nowMs >= 10_000 ? { startSec, closesAt } : null;
}

async function marketExists(c: PoolClient, id: string): Promise<boolean> {
  const r = await c.query(`SELECT 1 FROM prediction_markets WHERE market_id = $1`, [id]);
  return (r.rowCount ?? 0) > 0;
}

async function openSimMarkets(c: PoolClient, now: Date): Promise<number> {
  const cfg = predictionsConfig();
  const coins = await c.query<{ coin_id: string; ticker: string; price_micros: string }>(
    `SELECT coin_id, ticker, price_micros FROM coins
      WHERE ${ENGINE_ONLY_COINS} AND price_micros > 0
      ORDER BY vol_5m_cents DESC, coin_id
      LIMIT $1`,
    [cfg.sim.topCoins],
  );
  let n = 0;
  for (const h of cfg.sim.horizons) {
    const p = period(now.getTime(), h.everySec, h.betWindowSec);
    if (!p) continue;
    const resolvesAt = new Date((p.startSec + HORIZON_SEC[h.horizon]) * 1000);
    for (const coin of coins.rows) {
      const ok = await insertMarket(c, {
        id: `sim:${coin.coin_id}:${h.horizon}:${p.startSec}`,
        kind: 'sim',
        questionKey: 'sim_higher',
        params: { coinId: coin.coin_id, ticker: coin.ticker, strikeMicros: coin.price_micros },
        horizon: h.horizon,
        opensAt: now,
        closesAt: p.closesAt,
        resolvesAt,
        source: { type: 'sim', ref: coin.coin_id },
        strikeMicros: BigInt(coin.price_micros),
        basis: { coinId: coin.coin_id },
      });
      if (ok) n++;
    }
  }
  return n;
}

async function openEventMarkets(c: PoolClient, now: Date): Promise<number> {
  const ev = predictionsConfig().event;
  const p = period(now.getTime(), ev.everySec, ev.betWindowSec);
  if (!p) return 0;
  let n = 0;
  for (const q of ev.questions) {
    // The set the question is about is fixed now: rugs among the engine-only
    // live coins, graduations among the coins still on the curve.
    const coins = await c.query<{ coin_id: string; stage: string }>(
      q === 'event_rug_1h'
        ? `SELECT coin_id, stage FROM coins WHERE ${ENGINE_ONLY_COINS} ORDER BY coin_id`
        : `SELECT coin_id, stage FROM coins
            WHERE stage = 'new' AND NOT player_launched AND creator_id IS NULL ORDER BY coin_id`,
    );
    if (coins.rows.length === 0) continue;
    const ok = await insertMarket(c, {
      id: `event:${q}:${p.startSec}`,
      kind: 'event',
      questionKey: q,
      params: { coins: String(coins.rows.length) },
      horizon: ev.horizon,
      opensAt: now,
      closesAt: p.closesAt,
      resolvesAt: new Date((p.startSec + HORIZON_SEC[ev.horizon]) * 1000),
      source: { type: 'sim', ref: 'market' },
      strikeMicros: null,
      basis: {
        coinIds: coins.rows.map((r) => r.coin_id),
        openStages: Object.fromEntries(coins.rows.map((r) => [r.coin_id, r.stage])),
      },
    });
    if (ok) n++;
  }
  return n;
}

async function openCryptoMarkets(
  ctx: AppContext,
  now: Date,
  source: ReferencePriceSource,
): Promise<number> {
  const cr = predictionsConfig().crypto;
  const p = period(now.getTime(), cr.everySec, cr.betWindowSec);
  if (!p) return 0;
  let n = 0;
  for (const symbol of cr.symbols) {
    const id = `crypto:${symbol}:${p.startSec}`;
    if (await ctx.db.withConnection((c) => marketExists(c, id))) continue;
    // The strike is the open of the period's first minute, read from the source.
    const candle = await source.minuteCandle(symbol, p.startSec * 1000);
    if (!candle) continue; // source down: sim and event markets still open
    const ok = await ctx.db.withConnection((c) =>
      insertMarket(c, {
        id,
        kind: 'crypto',
        questionKey: 'crypto_higher_24h',
        params: { symbol, strikeMicros: candle.openMicros.toString() },
        horizon: 'daily',
        opensAt: new Date(p.startSec * 1000),
        closesAt: p.closesAt,
        resolvesAt: new Date((p.startSec + cr.horizonSec) * 1000),
        source: { type: source.type, ref: source.ref },
        strikeMicros: candle.openMicros,
        basis: { symbol },
      }),
    );
    if (ok) n++;
  }
  return n;
}

/**
 * Record each event coin's stage right after the bet window closed
 * (`basis.closedStages`, `basis.closedAt`), once. The resolver counts only
 * changes after this, so a rug that happened while bets were open never
 * decides the market. Called by the generator (every minute) and by the
 * settlement sweep (every 5 s), so it lands within seconds of `closesAt`.
 * @param c - A client.
 * @param now - The current time.
 */
export async function snapshotClosedEvents(c: Pick<PoolClient, 'query'>, now: Date): Promise<void> {
  await c.query(
    `UPDATE prediction_markets m
        SET basis = m.basis || jsonb_build_object(
              'closedAt', to_jsonb($1::timestamptz),
              'closedStages', COALESCE((
                SELECT jsonb_object_agg(co.coin_id::text, co.stage) FROM coins co
                 WHERE co.coin_id::text IN (SELECT jsonb_array_elements_text(m.basis->'coinIds'))
              ), '{}'::jsonb))
      WHERE m.kind = 'event' AND m.status IN ('open', 'closed') AND m.closes_at <= $1
        AND NOT (m.basis ? 'closedStages')`,
    [now],
  );
}

/**
 * One generator run: open due markets, snapshot sim prices, close ended
 * windows, prune. Safe to run on several replicas at once.
 * @param ctx - The app context.
 * @param now - The current time.
 * @param source - The crypto reference source, or null when off.
 * @returns How many markets were opened.
 */
export async function generateMarkets(
  ctx: AppContext,
  now: Date,
  source: ReferencePriceSource | null,
): Promise<number> {
  const opened = await ctx.db.withConnection(async (c) => {
    const sim = await openSimMarkets(c, now);
    const ev = await openEventMarkets(c, now);
    // Price of every coin an unresolved sim market is about, this minute.
    await c.query(
      `INSERT INTO prediction_price_snapshots (coin_id, minute, price_micros)
       SELECT co.coin_id, date_trunc('minute', $1::timestamptz), co.price_micros
         FROM coins co
        WHERE co.coin_id IN (SELECT (source->>'ref')::uuid FROM prediction_markets
                              WHERE kind = 'sim' AND status IN ('open', 'closed'))
       ON CONFLICT (coin_id, minute) DO NOTHING`,
      [now],
    );
    await snapshotClosedEvents(c, now);
    await c.query(
      `UPDATE prediction_markets SET status = 'closed' WHERE status = 'open' AND closes_at <= $1`,
      [now],
    );
    const days = predictionsConfig().pruneAfterDays;
    await c.query(
      `DELETE FROM prediction_price_snapshots WHERE minute < $1::timestamptz - make_interval(days => $2)`,
      [now, days],
    );
    await c.query(
      `DELETE FROM prediction_markets m
        WHERE m.status IN ('resolved', 'void')
          AND m.resolves_at < $1::timestamptz - make_interval(days => $2)
          AND NOT EXISTS (SELECT 1 FROM predictions p WHERE p.market_id = m.market_id)`,
      [now, days],
    );
    return sim + ev;
  });
  return opened + (source ? await openCryptoMarkets(ctx, now, source) : 0);
}

const ListQuery = z.object({
  status: z.enum(['open', 'closed', 'resolved', 'void']).default('open'),
  cursor: z.string().max(200).optional(),
});

const PAGE = 50;

function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(s: string): { at: Date; id: string } {
  const [at, id] = Buffer.from(s, 'base64url').toString('utf8').split('|');
  const d = new Date(at ?? '');
  if (!id || Number.isNaN(d.getTime())) throw new ValidationFailedError({ reason: 'bad_cursor' });
  return { at: d, id };
}

/**
 * GET /predictions/markets. `open` lists markets taking bets now, soonest
 * window end first; the other statuses list newest resolution first.
 * @param ctx - The app context.
 * @param query - The raw query (`status`, `cursor`).
 * @param now - The current time.
 * @returns A page of markets and the next cursor.
 */
export async function listMarkets(
  ctx: AppContext,
  query: unknown,
  now: Date = new Date(),
): Promise<{ markets: MarketView[]; nextCursor: string | null }> {
  const q = ListQuery.safeParse(query);
  if (!q.success) throw new ValidationFailedError({ issues: q.error.issues });
  const { status } = q.data;
  const cur = q.data.cursor ? decodeCursor(q.data.cursor) : null;
  const open = status === 'open';
  const where = open
    ? `status = 'open' AND closes_at > $1`
    : status === 'closed'
      ? `(status = 'closed' OR (status = 'open' AND closes_at <= $1))`
      : `status = '${status}'`;
  const key = open ? 'closes_at' : 'resolves_at';
  const cmp = open ? '>' : '<';
  const params: unknown[] = [now, PAGE + 1];
  let after = '';
  if (cur) {
    params.push(cur.at, cur.id);
    after = ` AND (${key}, market_id) ${cmp} ($3, $4)`;
  }
  const r = await ctx.db.withConnection((c) =>
    c.query<MarketRow>(
      `SELECT ${MARKET_COLUMNS} FROM prediction_markets
        WHERE ${where}${after} AND $1::timestamptz IS NOT NULL
        ORDER BY ${key} ${open ? 'ASC' : 'DESC'}, market_id ${open ? 'ASC' : 'DESC'}
        LIMIT $2`,
      params,
    ),
  );
  const rows = r.rows.slice(0, PAGE);
  const last = rows[rows.length - 1];
  const nextCursor =
    r.rows.length > PAGE && last
      ? encodeCursor(open ? last.closes_at : last.resolves_at, last.market_id)
      : null;
  return { markets: rows.map((row) => toMarketView(row, now)), nextCursor };
}
