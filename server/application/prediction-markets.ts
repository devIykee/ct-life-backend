/**
 * Prediction Pit markets (unlock D3): generation and the public list.
 *
 *   GET /v1/predictions/markets?status=open&cursor=
 *
 * The market worker (server/workers/prediction-markets.ts) calls
 * `generateMarkets` once a minute. It opens:
 *   - `sim` (`sim_call`): a sealed house call themed on one of the top in-game
 *     coins, at the 5m / 15m / 1h horizons;
 *   - `event` (`event_rug_1h`): the same kind of sealed call, off by default
 *     (its copy would read as a real rug question, which it is not);
 *   - `crypto`: "is BTC (SOL) higher in 24 h than now?" from the configured
 *     reference source, only when PREDICTIONS_CRYPTO_SOURCE is not `off`.
 *
 * Why sim and event markets are sealed draws, not price questions: every house
 * coin keeps a fixed hidden drift for its whole life (hidden-arc.ts), and that
 * drift shows in public data (`change5mBps`, the price history). A question
 * about the coin's own price was therefore close to certain (a security review
 * measured "yes" winning 100% of the time on graduated coins). Their outcome is
 * now a commit-reveal draw, the standard "provably fair" pattern:
 *   - at open the server draws a fresh 32-byte secret and publishes only
 *     `commitment = sha256(secret)` (`fairness.commitment`);
 *   - at `resolvesAt` the outcome is `yes` iff the low bit of
 *     HMAC-SHA256(secret, marketId)[0] is 1, and the secret is published
 *     (`fairness.seed`), so anyone can check both the hash and the outcome;
 *   - nothing public (the coin, its trend, other markets) says anything about
 *     the secret, and the server cannot change the outcome after bets because
 *     the commitment is already public.
 * Both outcomes have probability 1/2; at 1.9x the house keeps 5%.
 *
 * Markets take bets only for a short window after they open (`betWindowSec`).
 * Ids are deterministic per period, so two worker replicas insert the same
 * market once (`ON CONFLICT DO NOTHING`). The worker also marks markets whose
 * window ended `closed` and prunes old unbet markets.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
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
  /** Commit-reveal proof for sealed draws (sim, event); null for crypto. */
  readonly fairness: { commitment: string; seed: string | null } | null;
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
  basis: { symbol?: string; seed?: string; commitment?: string };
  resolved_outcome_id: string | null;
}

export const MARKET_COLUMNS = `market_id, kind, question_key, params, outcomes, horizon, opens_at,
  closes_at, resolves_at, source, payout_bps, min_stake_cents, max_stake_cents, status,
  strike_micros, basis, resolved_outcome_id`;

/**
 * The commitment published for a secret.
 * @param seedHex - The 32-byte secret, hex.
 * @returns sha256 of the secret bytes, hex.
 */
export function commitmentOf(seedHex: string): string {
  return createHash('sha256').update(Buffer.from(seedHex, 'hex')).digest('hex');
}

/**
 * The outcome a revealed secret gives a market (anyone can recompute it).
 * @param seedHex - The revealed secret, hex.
 * @param marketId - The market.
 * @returns `yes` iff the low bit of HMAC-SHA256(secret, marketId)[0] is 1.
 */
export function drawOutcome(seedHex: string, marketId: string): 'yes' | 'no' {
  const mac = createHmac('sha256', Buffer.from(seedHex, 'hex')).update(marketId).digest();
  return (mac[0]! & 1) === 1 ? 'yes' : 'no';
}

/**
 * The wire shape of a market row. The secret is only shown once resolved.
 * @param r - The row.
 * @param now - The current time (an open market past its window reads `closed`).
 * @returns The contract `PredictionMarket`.
 */
export function toMarketView(r: MarketRow, now: Date): MarketView {
  const status = r.status === 'open' && r.closes_at <= now ? 'closed' : r.status;
  const sealed = r.basis.commitment !== undefined;
  const revealed = r.status === 'resolved' || r.status === 'void';
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
    fairness: sealed
      ? { commitment: r.basis.commitment!, seed: revealed ? (r.basis.seed ?? null) : null }
      : null,
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

/** A fresh secret and its commitment for a sealed draw. */
function sealedDraw(): { seed: string; commitment: string } {
  const seed = randomBytes(32).toString('hex');
  return { seed, commitment: commitmentOf(seed) };
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
  // The coin is only the theme of a sealed call; its price decides nothing.
  const coins = await c.query<{ coin_id: string; ticker: string }>(
    `SELECT coin_id, ticker FROM coins
      WHERE stage <> 'dead' AND NOT player_launched AND creator_id IS NULL
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
      const draw = sealedDraw();
      const ok = await insertMarket(c, {
        id: `sim:${coin.coin_id}:${h.horizon}:${p.startSec}`,
        kind: 'sim',
        questionKey: 'sim_call',
        params: { coinId: coin.coin_id, ticker: coin.ticker, commitment: draw.commitment },
        horizon: h.horizon,
        opensAt: now,
        closesAt: p.closesAt,
        resolvesAt,
        source: { type: 'sim', ref: 'sealed_draw' },
        strikeMicros: null,
        basis: draw,
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
    const draw = sealedDraw();
    const ok = await insertMarket(c, {
      id: `event:${q}:${p.startSec}`,
      kind: 'event',
      questionKey: q,
      params: { commitment: draw.commitment },
      horizon: ev.horizon,
      opensAt: now,
      closesAt: p.closesAt,
      resolvesAt: new Date((p.startSec + HORIZON_SEC[ev.horizon]) * 1000),
      source: { type: 'sim', ref: 'sealed_draw' },
      strikeMicros: null,
      basis: draw,
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
    if (!candle) continue; // source down: sim markets still open
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
 * One generator run: open due markets, close ended windows, prune. Safe to
 * run on several replicas at once.
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
    await c.query(
      `UPDATE prediction_markets SET status = 'closed' WHERE status = 'open' AND closes_at <= $1`,
      [now],
    );
    await c.query(
      `DELETE FROM prediction_markets m
        WHERE m.status IN ('resolved', 'void')
          AND m.resolves_at < $1::timestamptz - make_interval(days => $2)
          AND NOT EXISTS (SELECT 1 FROM predictions p WHERE p.market_id = m.market_id)`,
      [now, predictionsConfig().pruneAfterDays],
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
