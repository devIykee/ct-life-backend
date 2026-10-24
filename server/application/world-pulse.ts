/**
 * World pulse: the live mood and recent-event feed the NPC brains and the
 * city room read.
 *
 * `CityState.mood` is documented as basis points of the market's move,
 * clamped to -10000..+10000. There is no external price feed configured,
 * so the mood is the volume-weighted 5m change of the in-game coins, which
 * is the market the players actually trade. Both the city room (which used
 * a sine wave) and `VenueRoom.tickNpcs` (which passed a hardcoded 0 and an
 * empty event list) read from here so they never disagree.
 */
import type { AppContext } from './context.js';
import type { NpcEvent } from '../../packages/npc-brain/src/index.js';

const MOOD_CLAMP_BPS = 10_000;
/** How far back a launch or a rug still counts as news. */
const EVENT_WINDOW_MIN = 15;
const MAX_EVENTS = 20;

/**
 * The current market mood in basis points.
 * @param ctx - The application context.
 * @returns Volume-weighted 5m change, clamped to -10000..+10000, 0 with no market.
 */
export async function getMoodBps(ctx: AppContext): Promise<number> {
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<{ mood: string | null }>(
      `SELECT CASE
                WHEN COALESCE(SUM(vol_5m_cents), 0) > 0
                  THEN SUM(change_5m_bps::numeric * vol_5m_cents) / SUM(vol_5m_cents)
                ELSE AVG(change_5m_bps::numeric)
              END::text AS mood
         FROM coins
        WHERE stage <> 'dead'`,
    );
  });
  const raw = Number(r.rows[0]?.mood ?? '0');
  if (!Number.isFinite(raw)) return 0;
  return Math.max(-MOOD_CLAMP_BPS, Math.min(MOOD_CLAMP_BPS, Math.round(raw)));
}

/**
 * Recent world events for the NPC brains.
 *
 * Launches and rugs come from the coins table; a liquidation is a perp
 * closed at a loss. `spotId` is the caller's venue anchor, since the brains
 * use it to decide where to react.
 * @param ctx - The application context.
 * @param anchorSpotId - The spot to attach venue-local events to.
 * @returns Newest-first events, capped.
 */
export async function getRecentEvents(ctx: AppContext, anchorSpotId: string): Promise<NpcEvent[]> {
  const out: NpcEvent[] = [];
  const rows = await ctx.db.withConnection(async (c) => {
    const coins = await c.query<{ ticker: string; stage: string; launched_at: Date }>(
      `SELECT ticker, stage, launched_at
         FROM coins
        WHERE launched_at > now() - ($1 || ' minutes')::interval
           OR (stage = 'dead' AND launched_at > now() - '1 day'::interval)
        ORDER BY launched_at DESC
        LIMIT $2`,
      [String(EVENT_WINDOW_MIN), MAX_EVENTS],
    );
    return coins.rows;
  });
  for (const row of rows) {
    out.push(
      row.stage === 'dead'
        ? { kind: 'rug', coin: row.ticker, spotId: anchorSpotId }
        : { kind: 'launch', coin: row.ticker, spotId: anchorSpotId },
    );
  }
  return out.slice(0, MAX_EVENTS);
}

export interface MarketCoinSnapshot {
  readonly coinId: string;
  readonly ticker: string;
  readonly name: string;
  readonly stage: string;
  readonly priceMicros: bigint;
  readonly mcapCents: bigint;
  readonly vol5mCents: bigint;
  readonly change5mBps: number;
  readonly holders: number;
  readonly launchedAt: bigint;
  /** Launched by a player through the Rugpull Factory. */
  readonly playerLaunched: boolean;
  /** Factory art id, '' for house coins. */
  readonly templateId: string;
}

/**
 * The coins the market room should broadcast.
 *
 * Read from the coins table rather than the engine's per-coin Redis
 * snapshots: the table is authoritative, needs no key scan, and still
 * serves the last known prices when the engine is paused.
 * @param ctx - The application context.
 * @param limit - How many coins to publish, by market cap.
 * @returns Coin snapshots, largest first.
 */
export async function listMarketCoins(
  ctx: AppContext,
  limit: number,
): Promise<MarketCoinSnapshot[]> {
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<{
      coin_id: string;
      ticker: string;
      name: string;
      stage: string;
      price_micros: string;
      mcap_cents: string;
      vol_5m_cents: string;
      change_5m_bps: number;
      holders: number;
      launched_at: Date;
      player_launched: boolean;
      template_id: string | null;
    }>(
      `SELECT c.coin_id, c.ticker, c.name, c.stage, c.price_micros, c.mcap_cents,
              c.vol_5m_cents, c.change_5m_bps,
              (SELECT COUNT(*)::int FROM positions p WHERE p.coin_id = c.coin_id AND p.units > 0)
                AS holders,
              c.launched_at, c.player_launched, f.template_id
         FROM coins c
         LEFT JOIN factory_coins f ON f.coin_id = c.coin_id
        WHERE c.stage <> 'dead'
        ORDER BY (c.player_launched AND c.launched_at > now() - interval '30 minutes') DESC,
                 c.mcap_cents DESC
        LIMIT $1`,
      [limit],
    );
  });
  return r.rows.map((row) => ({
    coinId: row.coin_id,
    ticker: row.ticker,
    name: row.name,
    stage: row.stage,
    priceMicros: BigInt(row.price_micros),
    mcapCents: BigInt(row.mcap_cents),
    vol5mCents: BigInt(row.vol_5m_cents),
    change5mBps: row.change_5m_bps,
    holders: row.holders,
    launchedAt: BigInt(row.launched_at.getTime()),
    playerLaunched: row.player_launched,
    templateId: row.template_id ?? '',
  }));
}

export interface DreamProgress {
  readonly current: number;
  readonly target: number;
  readonly unit: string;
  readonly completedAt: string | null;
}

interface DreamRule {
  id: string;
  metric: string;
  target: number;
  unit: string;
}

/**
 * Progress towards the player's dream.
 *
 * dreams.json names the metric and target for every dream. Only the
 * metrics with a real data source behind them are computed; the rest
 * return null so the client keeps the progress bar hidden rather than
 * being shown a made-up number.
 * @param ctx - The application context.
 * @param userId - The calling user.
 * @param dreamId - The dream from the player's character.
 * @returns Progress, or null when the metric cannot be measured yet.
 */
export async function getDreamProgress(
  ctx: AppContext,
  userId: string,
  dreamId: string,
): Promise<DreamProgress | null> {
  const cfg = ctx.configCache.load<{ dreams: DreamRule[] }>('dreams');
  const rule = cfg.dreams.find((d) => d.id === dreamId);
  if (!rule) return null;

  let current: number | null = null;
  if (rule.metric === 'net_worth_cents') {
    const r = await ctx.db.withConnection(async (c) => {
      return c.query<{ cash_cents: string; debt_cents: string }>(
        'SELECT cash_cents, debt_cents FROM balances WHERE user_id = $1',
        [userId],
      );
    });
    const row = r.rows[0];
    current = Number(row?.cash_cents ?? '0') - Number(row?.debt_cents ?? '0');
  } else if (rule.metric === 'projects_launched') {
    const r = await ctx.db.withConnection(async (c) => {
      return c.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM projects
          WHERE owner_user_id = $1 AND status IN ('live', 'launching')`,
        [userId],
      );
    });
    current = Number(r.rows[0]?.n ?? '0');
  } else if (rule.metric === 'rich_list_rank') {
    const r = await ctx.db.withConnection(async (c) => {
      return c.query<{ rank: string }>(
        `SELECT COUNT(*) + 1 AS rank
           FROM balances b
          WHERE (b.cash_cents - b.debt_cents) >
                COALESCE((SELECT cash_cents - debt_cents FROM balances WHERE user_id = $1), 0)`,
        [userId],
      );
    });
    current = Number(r.rows[0]?.rank ?? '0');
  }
  if (current === null) return null;

  // rank counts down to 1; every other metric counts up to the target.
  const done = rule.unit === 'rank' ? current <= rule.target : current >= rule.target;
  return {
    current: Math.max(0, current),
    target: rule.target,
    unit: rule.unit,
    completedAt: done ? new Date().toISOString() : null,
  };
}
