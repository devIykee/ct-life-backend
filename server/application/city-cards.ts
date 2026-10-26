/**
 * City event cards on the Timeline (board timeline-36, decision D2: server
 * posts, not a client-side merge). Each card is a `feed_posts` row by the city
 * system user, so the app, the Timeline Square screen and any HUD read the
 * same rows.
 *
 *   launch       "smoothbrain launched $FROG"            one per coin
 *   rug          "RUGGED: $FROG by smoothbrain"          one per coin
 *                "$FROG went to zero" (house coin died)
 *   liquidation  "$120k of longs liquidated on Hyperliquid"
 *                one card per 10-minute window, totals updated in place
 *   casino_win   "lucky_ape hit 40x on crash in the Casino"
 *                10x or more and $10+ paid, at most one per 2 minutes
 *
 * Write-side limits keep a burst from flooding the City tab (launches and
 * rugs: 4 a minute each); the For-you tab also spaces city cards at most 1
 * in every 4 rows (timeline.ts). Every function here runs after the action
 * committed and never throws: a card is decoration, not part of the action.
 */
import type { AppContext } from './context.js';
import { CITY_USER_ID, insertSystemPost } from './timeline.js';

const PER_MINUTE: Record<string, number> = { launch: 4, rug: 4 };
const CASINO_WIN_MIN_X = 10;
const CASINO_WIN_MIN_PAYOUT_CENTS = 1_000;
const CASINO_WIN_GAP_S = 120;
const LIQ_BUCKET_MS = 10 * 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "$120k", "$4.2k", "$85" from cents. */
export function shortCash(cents: number | bigint): string {
  const d = Number(cents) / 100;
  if (d >= 1_000_000) return `$${(d / 1_000_000).toFixed(d >= 10_000_000 ? 0 : 1)}M`;
  if (d >= 1_000) return `$${(d / 1_000).toFixed(d >= 10_000 ? 0 : 1)}k`;
  return `$${Math.round(d)}`;
}

async function underLimit(ctx: AppContext, kind: string, now: Date): Promise<boolean> {
  const cap = PER_MINUTE[kind];
  if (cap === undefined) return true;
  const key = `tl:city:${kind}:${Math.floor(now.getTime() / 60_000)}`;
  const n = await ctx.redis.main.incr(key);
  if (n === 1) await ctx.redis.main.expire(key, 120);
  return n <= cap;
}

async function aliasOf(ctx: AppContext, userId: string): Promise<string> {
  const r = await ctx.db.withConnection((c) =>
    c.query<{ alias: string }>(`SELECT alias FROM characters WHERE user_id = $1`, [userId]),
  );
  return r.rows[0]?.alias ?? 'anon';
}

async function safely(what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`[city-cards] ${what} failed:`, (e as Error).message);
  }
}

/**
 * A coin launched (player factory, launchpad or house).
 * @param ctx - The app context.
 * @param c - The coin and, for a player launch, who launched it.
 * @param now - Current time.
 */
export async function cardCoinLaunch(
  ctx: AppContext,
  c: {
    coinId: string;
    ticker: string;
    launcherUserId?: string | null;
    launcherAlias?: string | null;
  },
  now: Date = new Date(),
): Promise<void> {
  await safely('launch', async () => {
    if (!(await underLimit(ctx, 'launch', now))) return;
    // House coins are launched as userId 'house': no launcher to name.
    const launcher = c.launcherUserId && UUID_RE.test(c.launcherUserId) ? c.launcherUserId : null;
    const alias = c.launcherAlias ?? (launcher ? await aliasOf(ctx, launcher) : null);
    const text = alias ? `${alias} launched $${c.ticker}` : `$${c.ticker} just launched`;
    await ctx.db.withConnection((db) =>
      insertSystemPost(db, {
        userId: CITY_USER_ID,
        kind: 'launch',
        text,
        meta: {
          coinId: c.coinId,
          ticker: c.ticker,
          launcherUserId: launcher,
          launcherAlias: alias,
          card: { type: 'coin', coinId: c.coinId },
        },
        eventKey: `launch:${c.coinId}`,
        at: now,
      }),
    );
  });
}

/**
 * A coin rugged (creator dump flagged by the Sleuth) or a house coin died.
 * @param ctx - The app context.
 * @param c - The coin, the reason and the dev's alias for a dump.
 * @param now - Current time.
 */
export async function cardCoinRug(
  ctx: AppContext,
  c: { coinId: string; ticker: string; reason: 'creator_dump' | 'dead'; alias?: string | null },
  now: Date = new Date(),
): Promise<void> {
  await safely('rug', async () => {
    if (!(await underLimit(ctx, 'rug', now))) return;
    const text =
      c.reason === 'creator_dump'
        ? `RUGGED: $${c.ticker} by ${c.alias ?? 'an anonymous dev'}`
        : `$${c.ticker} went to zero`;
    await ctx.db.withConnection((db) =>
      insertSystemPost(db, {
        userId: CITY_USER_ID,
        kind: 'rug',
        text,
        meta: {
          coinId: c.coinId,
          ticker: c.ticker,
          reason: c.reason,
          launcherAlias: c.alias ?? null,
          card: { type: 'coin', coinId: c.coinId },
        },
        eventKey: `rug:${c.coinId}`,
        at: now,
      }),
    );
  });
}

/**
 * A perp was liquidated. Folded into one card per 10-minute window.
 * @param ctx - The app context.
 * @param l - Side and notional (margin x leverage) in cents.
 * @param now - Current time.
 */
export async function cardLiquidation(
  ctx: AppContext,
  l: { side: 'long' | 'short'; notionalCents: bigint | number },
  now: Date = new Date(),
): Promise<void> {
  await safely('liquidation', async () => {
    const bucket = Math.floor(now.getTime() / LIQ_BUCKET_MS);
    const n = BigInt(l.notionalCents);
    const long = l.side === 'long' ? n : 0n;
    const short = l.side === 'short' ? n : 0n;
    await ctx.db.withConnection(async (db) => {
      const r = await db.query<{ meta: { longCents: string; shortCents: string; count: number } }>(
        `INSERT INTO feed_posts (post_id, user_id, text, created_at, kind, meta, event_key)
         VALUES (gen_random_uuid(), $1, 'liquidations', $2, 'liquidation',
                 jsonb_build_object('longCents', $3::text, 'shortCents', $4::text, 'count', 1,
                                    'venueId', 'perp_pit',
                                    'card', jsonb_build_object('type', 'venue', 'venueId', 'perp_pit')),
                 $5)
         ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO UPDATE SET
           meta = feed_posts.meta || jsonb_build_object(
             'longCents', ((feed_posts.meta ->> 'longCents')::numeric + $3::numeric)::text,
             'shortCents', ((feed_posts.meta ->> 'shortCents')::numeric + $4::numeric)::text,
             'count', (feed_posts.meta ->> 'count')::int + 1)
         RETURNING meta`,
        [CITY_USER_ID, now, long.toString(), short.toString(), `liq:${bucket}`],
      );
      const m = r.rows[0]!.meta;
      const lc = BigInt(m.longCents);
      const sc = BigInt(m.shortCents);
      const side = lc > 0n && sc > 0n ? 'positions' : lc > 0n ? 'longs' : 'shorts';
      await db.query(`UPDATE feed_posts SET text = $2 WHERE event_key = $1`, [
        `liq:${bucket}`,
        `${shortCash(lc + sc)} of ${side} liquidated on Hyperliquid`,
      ]);
    });
  });
}

/**
 * A casino round settled. Only big wins become cards.
 * @param ctx - The app context.
 * @param userId - The winner.
 * @param round - The settled round.
 * @param now - Current time.
 */
export async function cardCasinoWin(
  ctx: AppContext,
  userId: string,
  round: { game: string; stakeCents: number; payoutCents: number | null; status: string },
  now: Date = new Date(),
): Promise<void> {
  await safely('casino_win', async () => {
    const payout = round.payoutCents ?? 0;
    if (round.status !== 'settled' || round.stakeCents <= 0) return;
    const x = payout / round.stakeCents;
    if (x < CASINO_WIN_MIN_X || payout < CASINO_WIN_MIN_PAYOUT_CENTS) return;
    const slot = await ctx.redis.main.set('tl:city:casino_win', '1', 'EX', CASINO_WIN_GAP_S, 'NX');
    if (slot !== 'OK') return;
    const alias = await aliasOf(ctx, userId);
    const mult = x >= 100 ? Math.round(x) : Math.round(x * 10) / 10;
    await ctx.db.withConnection((db) =>
      insertSystemPost(db, {
        userId: CITY_USER_ID,
        kind: 'casino_win',
        text: `${alias} hit ${mult}x on ${round.game} in the Casino`,
        meta: {
          winnerUserId: userId,
          winnerAlias: alias,
          game: round.game,
          multiplier: mult,
          payoutCents: payout,
          venueId: 'rug_room',
          card: { type: 'venue', venueId: 'rug_room' },
        },
        at: now,
      }),
    );
  });
}
