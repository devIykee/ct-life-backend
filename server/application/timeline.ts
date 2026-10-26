/**
 * The Timeline as the city's front page (board timeline-36; docs/TIMELINE.md).
 *
 *   GET  /v1/feed?tab=foryou|following|city&type=&before=
 *   POST /v1/feed/posts          {text, withPlace?}
 *   POST /v1/feed/checkins       {venueId}
 *
 * One stream, many authors: players, the NPC callers, the Sleuth and the
 * city itself (event cards for launches, rugs, liquidations and big casino
 * wins, written by the server into `feed_posts`). Every post carries at most
 * one action card (a coin, a place or a player) hydrated at read time, so a
 * coin card always shows today's price and turns red once rugged.
 *
 * Tabs:
 *   foryou     people, NPCs and the Sleuth, with city event cards mixed in at
 *              most 1 in every 4 rows (the rest live in the City tab). When
 *              nobody has posted, the last few city cards and `quiet: true`.
 *   following  posts by the people and NPC callers you follow.
 *   city       only city event cards, filterable by `type`.
 *
 * Location is the server's: a post's district and place come from the
 * position hash the street, venue and vehicle rooms keep, never from the
 * client. A place card and a check-in are opt-in per post.
 */
import type { PoolClient } from 'pg';
import type { AppContext } from './context.js';
import { runInTransaction } from '../shared/db/uow.js';
import { ValidationFailedError, RateLimitedError } from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import {
  decodePos,
  getIslandGeometry,
  pointInPolygon,
  POS_HASH,
  type IslandPos,
} from '../realtime/movement.js';

export const CITY_KINDS = ['launch', 'rug', 'liquidation', 'casino_win'] as const;
export type CityKind = (typeof CITY_KINDS)[number];
/** Must match the partial index predicates in migration 102. */
const CITY_PRED = `p.kind IN ('launch', 'rug', 'liquidation', 'casino_win')`;
const SOCIAL_PRED = `(p.kind IS NULL OR p.kind NOT IN ('launch', 'rug', 'liquidation', 'casino_win'))`;

export const CITY_USER_ID = '00000000-0000-4000-8000-00000000c17e';
const PAGE = 40;
/** City cards in For you: at most one per this many rows. */
const CITY_EVERY = 4;
const QUIET_CITY_CARDS = 5;
const POST_TEXT_MAX = 280;
/** A position older than this does not place a post. */
const POS_POST_FRESH_MS = 120_000;
/** How close to a venue door counts as "at" it. */
const PLACE_RADIUS_M = 60;
const CHECKIN_COOLDOWN_MS = 15 * 60_000;

export type PostKind =
  | 'player'
  | 'sleuth'
  | 'career'
  | 'caller'
  | 'checkin'
  | 'launch'
  | 'rug'
  | 'liquidation'
  | 'casino_win';

export interface CoinCard {
  readonly type: 'coin';
  readonly coinId: string;
  readonly ticker: string;
  readonly name: string;
  readonly stage: string;
  readonly mcapCents: string;
  readonly change5mBps: number;
  readonly holders: number;
  /** Creator dump flagged by the Sleuth, or the coin died. */
  readonly rugged: boolean;
  readonly dead: boolean;
  readonly deepLink: string;
}
export interface VenueCard {
  readonly type: 'venue';
  readonly venueId: string;
  readonly name: string;
  readonly deepLink: string;
}
export interface ProfileCard {
  readonly type: 'profile';
  readonly userId: string;
  readonly alias: string;
  readonly deepLink: string;
}
export type ActionCard = CoinCard | VenueCard | ProfileCard;

export interface TimelinePost {
  readonly postId: string;
  readonly userId: string;
  readonly alias: string;
  readonly text: string;
  readonly createdAt: string;
  readonly kind: PostKind;
  /** Authored by the city, the Sleuth or an NPC caller. */
  readonly isNpc: boolean;
  /** The tribe district (districts.slug) the post counts for, if any. */
  readonly district: string | null;
  readonly meta: Record<string, unknown> | null;
  /** The one action card (coin beats place). */
  readonly card: ActionCard | null;
  /** Sleuth posts and rug cards: the place pill next to the coin. */
  readonly secondaryCard: VenueCard | null;
  /** A coin card whose coin the Sleuth exposed: the verdict box under it. */
  readonly verdict: { postId: string; text: string; sellSharePct: number | null } | null;
  /** Launch cards: who bought in (faces only for people you follow). */
  readonly social: { holders: number; followed: { userId: string; alias: string }[] } | null;
}

export interface TimelinePage {
  readonly posts: TimelinePost[];
  /** Pass as `before` for the next page; null at the end. */
  readonly nextBefore: string | null;
  /** For you only: nobody posted, these are recent city cards. */
  readonly quiet: boolean;
}

// --- Places -----------------------------------------------------------------

/** Venues that are not in districts.json (yet) but cards point at. */
const EXTRA_VENUES: Record<string, string> = { rug_room: 'The Rug Room' };
let venueNames: Map<string, string> | null = null;

function venueName(ctx: AppContext, venueId: string): string | null {
  if (!venueNames) {
    const v = ctx.configCache.load<{ venues: { id: string; name: string }[] }>('venues');
    venueNames = new Map(v.venues.map((x) => [x.id, x.name]));
    for (const [id, name] of Object.entries(EXTRA_VENUES)) venueNames.set(id, name);
  }
  return venueNames.get(venueId) ?? null;
}

/**
 * A venue action card, or null for an unknown venue.
 * @param ctx - The app context (venue names).
 * @param venueId - A venues.json id, or rug_room.
 * @returns The card.
 */
export function venueCard(ctx: AppContext, venueId: string): VenueCard | null {
  const name = venueName(ctx, venueId);
  return name ? { type: 'venue', venueId, name, deepLink: `ctlife://venue/${venueId}` } : null;
}

/**
 * The player's last server-known island position, if fresh.
 * @param ctx - The app context.
 * @param userId - The player.
 * @param now - Current time.
 * @returns The position or null.
 */
export async function serverPosition(
  ctx: AppContext,
  userId: string,
  now: Date,
): Promise<IslandPos | null> {
  try {
    const p = decodePos(await ctx.redis.main.hget(POS_HASH, userId));
    return p && now.getTime() - p.at <= POS_POST_FRESH_MS ? p : null;
  } catch {
    return null;
  }
}

/** Island district at a point, or null off the map. */
export function islandDistrictAt(x: number, z: number): string | null {
  const geo = getIslandGeometry();
  for (const [slug, poly] of Object.entries(geo.districts)) {
    if (poly && poly.length >= 3 && pointInPolygon(poly, x, z)) return slug;
  }
  return null;
}

/**
 * Island districts that are a tribe district (`districts` table, seeded from
 * the tribes' home turfs plus marina_villa and cabal_lounge) under another slug.
 */
const ISLAND_TO_TURF: Record<string, string> = {
  trenches: 'the_trenches',
  airdrop_farm: 'airdrop_farm',
  builder_hills: 'builder_hills',
  dubai_marina: 'marina_villa',
};
/** Venues that are tribe districts in their own right. */
const VENUE_TURFS = new Set(['perp_pit', 'prediction_pit', 'spaces_studio', 'cabal_lounge']);

/**
 * The tribe district a post at this point counts for in the daily district
 * rollover: a turf venue the player is at, else their island district's turf.
 * @param x - Island x.
 * @param z - Island z.
 * @returns A `districts.slug`, or null when the point counts for none.
 */
export function turfAt(x: number, z: number): string | null {
  const venue = venueNear(x, z);
  if (venue && VENUE_TURFS.has(venue)) return venue;
  const island = islandDistrictAt(x, z);
  return island ? (ISLAND_TO_TURF[island] ?? null) : null;
}

/** The venue whose door is within PLACE_RADIUS_M of the point, nearest first. */
export function venueNear(x: number, z: number): string | null {
  const venues = getIslandGeometry().venues ?? {};
  let best: { id: string; d: number } | null = null;
  for (const [id, v] of Object.entries(venues)) {
    const d = Math.hypot(v.door[0] - x, v.door[1] - z);
    if (d <= PLACE_RADIUS_M && (!best || d < best.d)) best = { id, d };
  }
  return best?.id ?? null;
}

// --- Writing ----------------------------------------------------------------

const TICKER_RE = /\$([A-Za-z][A-Za-z0-9]{1,9})\b/;

/**
 * A player's post. The district comes from the server's position; a place card
 * is added only when the player asks (`withPlace`) and the server finds them at
 * a venue; a coin card when the text names a real coin's $TICKER (coin beats place).
 */
export async function createPlayerPost(
  ctx: AppContext,
  userId: string,
  text: string,
  opts: { withPlace?: boolean } = {},
  now: Date = new Date(),
): Promise<TimelinePost> {
  if (text.length < 1 || text.length > POST_TEXT_MAX) {
    throw new ValidationFailedError({ reason: 'text length 1..280' });
  }
  const pos = await serverPosition(ctx, userId, now);
  const district = pos ? turfAt(pos.x, pos.z) : null;
  let card: Record<string, unknown> | null = null;
  const t = TICKER_RE.exec(text);
  if (t) {
    const coin = await ctx.db.withConnection((c) =>
      c.query<{ coin_id: string; ticker: string }>(
        `SELECT coin_id, ticker FROM coins WHERE ticker = $1`,
        [t[1]!.toUpperCase()],
      ),
    );
    if (coin.rows[0]) card = { type: 'coin', coinId: coin.rows[0].coin_id };
  }
  if (!card && opts.withPlace && pos) {
    const venueId = venueNear(pos.x, pos.z);
    if (venueId && venueName(ctx, venueId)) card = { type: 'venue', venueId };
  }
  const postId = uuidv7();
  await runInTransaction(async (client) => {
    await client.query(
      `INSERT INTO feed_posts (post_id, user_id, text, created_at, kind, meta, district_slug)
       VALUES ($1, $2, $3, $4, 'player', $5, $6)`,
      [postId, userId, text, now, card ? JSON.stringify({ card }) : null, district],
    );
  });
  return (await postsByIds(ctx, userId, [postId]))[0]!;
}

/**
 * Opt-in check-in: "is at <venue>". Only when the server's position puts the
 * player at that venue's door, at most once per 15 minutes.
 */
export async function checkIn(
  ctx: AppContext,
  userId: string,
  venueId: string,
  now: Date = new Date(),
): Promise<TimelinePost> {
  const name = venueName(ctx, venueId);
  if (!name) throw new ValidationFailedError({ reason: 'unknown venue', venueId });
  const pos = await serverPosition(ctx, userId, now);
  const door = getIslandGeometry().venues?.[venueId]?.door;
  if (!pos || !door || Math.hypot(door[0] - pos.x, door[1] - pos.z) > PLACE_RADIUS_M) {
    throw new ValidationFailedError({ reason: 'not_at_venue', venueId });
  }
  const recent = await ctx.db.withConnection((c) =>
    c.query<{ created_at: Date }>(
      `SELECT created_at FROM feed_posts WHERE user_id = $1 AND kind = 'checkin'
        ORDER BY created_at DESC LIMIT 1`,
      [userId],
    ),
  );
  const last = recent.rows[0]?.created_at.getTime() ?? 0;
  if (now.getTime() - last < CHECKIN_COOLDOWN_MS) {
    throw new RateLimitedError(CHECKIN_COOLDOWN_MS - (now.getTime() - last), { limit: 1 });
  }
  const postId = uuidv7();
  await ctx.db.withConnection((c) =>
    c.query(
      `INSERT INTO feed_posts (post_id, user_id, text, created_at, kind, meta, district_slug)
       VALUES ($1, $2, $3, $4, 'checkin', $5, $6)`,
      [
        postId,
        userId,
        `is at ${name}`,
        now,
        JSON.stringify({ card: { type: 'venue', venueId } }),
        turfAt(pos.x, pos.z),
      ],
    ),
  );
  return (await postsByIds(ctx, userId, [postId]))[0]!;
}

// --- Reading ----------------------------------------------------------------

interface Row {
  post_id: string;
  user_id: string;
  alias: string;
  text: string;
  created_at: Date;
  kind: string | null;
  meta: Record<string, unknown> | null;
  district_slug: string | null;
  is_npc: boolean;
}

const SELECT = `
  SELECT p.post_id, p.user_id,
         COALESCE(n.display_name, ch.alias, 'anon') AS alias,
         p.text, p.created_at, p.kind, p.meta, p.district_slug,
         (n.user_id IS NOT NULL) AS is_npc
    FROM feed_posts p
    LEFT JOIN npc_authors n ON n.user_id = p.user_id
    LEFT JOIN characters ch ON ch.user_id = p.user_id`;
const NOT_BLOCKED = `NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_user_id = $1 AND b.blocked_user_id = p.user_id)`;

function cursorOf(before: string | null): Date {
  if (before === null) return new Date(8.64e15);
  const d = new Date(before);
  if (Number.isNaN(d.getTime())) throw new ValidationFailedError({ reason: 'bad cursor' });
  return d;
}

/**
 * Read one tab of the Timeline.
 * @param ctx - The app context.
 * @param userId - The reader (block list, follows, faces).
 * @param q - Tab, city type filter and cursor.
 * @returns The page.
 */
export async function listTimeline(
  ctx: AppContext,
  userId: string,
  q: { tab: 'foryou' | 'following' | 'city'; type?: CityKind | 'all'; before?: string | null },
): Promise<TimelinePage> {
  const before = cursorOf(q.before ?? null);
  const rows = await ctx.db.withConnection(async (c) => {
    if (q.tab === 'city') {
      const kinds = q.type && q.type !== 'all' ? [q.type] : [...CITY_KINDS];
      const r = await c.query<Row>(
        `${SELECT} WHERE ${CITY_PRED} AND p.kind = ANY($2::text[]) AND p.created_at < $3 AND ${NOT_BLOCKED}
          ORDER BY p.created_at DESC LIMIT $4`,
        [userId, kinds, before, PAGE],
      );
      return { list: r.rows, quiet: false, next: r.rows.length === PAGE };
    }
    if (q.tab === 'following') {
      // Newest PAGE per followee (feed_posts_user_created_idx), then the newest
      // PAGE overall: bounded by follows x PAGE rows, however rarely they post.
      const r = await c.query<Row>(
        `${SELECT}
          WHERE p.post_id IN (
            SELECT x.post_id FROM follows f
            CROSS JOIN LATERAL (
              SELECT p.post_id, p.created_at FROM feed_posts p
               WHERE p.user_id = f.followee_user_id AND ${SOCIAL_PRED} AND p.created_at < $2
               ORDER BY p.created_at DESC LIMIT $3) x
             WHERE f.follower_user_id = $1
             ORDER BY x.created_at DESC LIMIT $3)
            AND ${NOT_BLOCKED}
          ORDER BY p.created_at DESC`,
        [userId, before, PAGE],
      );
      return { list: r.rows, quiet: false, next: r.rows.length === PAGE };
    }
    // For you: the social lane, then city cards from the same time window.
    const social = await c.query<Row>(
      `${SELECT} WHERE ${SOCIAL_PRED} AND p.created_at < $2 AND ${NOT_BLOCKED}
        ORDER BY p.created_at DESC LIMIT $3`,
      [userId, before, PAGE],
    );
    if (social.rows.length === 0) {
      if (q.before) return { list: [], quiet: false, next: false };
      const city = await c.query<Row>(
        `${SELECT} WHERE ${CITY_PRED} AND ${NOT_BLOCKED} ORDER BY p.created_at DESC LIMIT $2`,
        [userId, QUIET_CITY_CARDS],
      );
      return { list: city.rows, quiet: true, next: false };
    }
    const full = social.rows.length === PAGE;
    const oldest = full
      ? social.rows[social.rows.length - 1]!.created_at
      : new Date('0001-01-01T00:00:00Z');
    const city = await c.query<Row>(
      `${SELECT} WHERE ${CITY_PRED} AND p.created_at < $2 AND p.created_at >= $3 AND ${NOT_BLOCKED}
        ORDER BY p.created_at DESC LIMIT $4`,
      [userId, before, oldest, Math.ceil(PAGE / (CITY_EVERY - 1))],
    );
    return { list: interleave(social.rows, city.rows), quiet: false, next: full };
  });
  const posts = await hydrate(ctx, userId, rows.list);
  const last = rows.list[rows.list.length - 1];
  return {
    posts,
    nextBefore: rows.next && last ? last.created_at.toISOString() : null,
    quiet: rows.quiet,
  };
}

/**
 * Merge the social lane with city cards, newest first, so that no two city
 * cards are closer than CITY_EVERY rows: at least CITY_EVERY - 1 social rows
 * between them, and before the first. Cards that do not fit are dropped (they
 * are in the City tab).
 * @param social - Social rows, newest first.
 * @param city - City rows, newest first.
 * @returns The merged rows.
 */
export function interleave<T extends { created_at: Date }>(social: T[], city: T[]): T[] {
  const out: T[] = [];
  let sinceCity = 0;
  let ci = 0;
  for (const s of social) {
    // Skip city cards newer than this social row that can no longer fit.
    while (ci < city.length && city[ci]!.created_at > s.created_at && sinceCity < CITY_EVERY - 1) {
      ci++;
    }
    if (ci < city.length && city[ci]!.created_at > s.created_at && sinceCity >= CITY_EVERY - 1) {
      out.push(city[ci++]!);
      sinceCity = 0;
    }
    out.push(s);
    sinceCity++;
  }
  return out;
}

async function postsByIds(ctx: AppContext, userId: string, ids: string[]): Promise<TimelinePost[]> {
  const r = await ctx.db.withConnection((c) =>
    c.query<Row>(`${SELECT} WHERE p.post_id = ANY($1::uuid[])`, [ids]),
  );
  return hydrate(ctx, userId, r.rows);
}

function normKind(k: string | null): PostKind {
  const known: PostKind[] = [
    'sleuth',
    'career',
    'caller',
    'checkin',
    'launch',
    'rug',
    'liquidation',
    'casino_win',
  ];
  return known.includes(k as PostKind) ? (k as PostKind) : 'player';
}

function coinIdOf(kind: PostKind, meta: Record<string, unknown> | null): string | null {
  const card = meta?.card as { type?: string; coinId?: string } | undefined;
  if (card?.type === 'coin' && typeof card.coinId === 'string') return card.coinId;
  if (['sleuth', 'launch', 'rug', 'caller'].includes(kind) && typeof meta?.coinId === 'string') {
    return meta.coinId;
  }
  return null;
}

async function hydrate(ctx: AppContext, userId: string, rows: Row[]): Promise<TimelinePost[]> {
  if (rows.length === 0) return [];
  const coinIds = [
    ...new Set(rows.map((r) => coinIdOf(normKind(r.kind), r.meta)).filter((x) => x !== null)),
  ] as string[];
  const launchCoins = [
    ...new Set(rows.filter((r) => r.kind === 'launch').map((r) => coinIdOf('launch', r.meta))),
  ].filter((x): x is string => x !== null);
  const [coins, verdicts, followed] = coinIds.length
    ? await ctx.db.withConnection(async (c) => [
        await c.query<{
          coin_id: string;
          ticker: string;
          name: string;
          stage: string;
          mcap_cents: string;
          change_5m_bps: number;
          holders: number;
          rugged: boolean;
        }>(
          `SELECT c.coin_id, c.ticker, c.name, c.stage, c.mcap_cents, c.change_5m_bps, c.holders,
                  (fc.rug_flagged_at IS NOT NULL) AS rugged
             FROM coins c LEFT JOIN factory_coins fc ON fc.coin_id = c.coin_id
            WHERE c.coin_id = ANY($1::uuid[])`,
          [coinIds],
        ),
        await c.query<{ coin_id: string; post_id: string; text: string; pct: string | null }>(
          `SELECT meta ->> 'coinId' AS coin_id, post_id, text, meta ->> 'sellSharePct' AS pct
             FROM feed_posts WHERE kind = 'sleuth' AND meta ->> 'coinId' = ANY($1::text[])`,
          [coinIds],
        ),
        launchCoins.length
          ? await c.query<{ coin_id: string; user_id: string; alias: string }>(
              `SELECT x.coin_id, x.user_id, x.alias FROM (
                 SELECT ps.coin_id, ps.user_id, COALESCE(ch.alias, 'anon') AS alias,
                        row_number() OVER (PARTITION BY ps.coin_id ORDER BY ps.created_at) AS n
                   FROM follows f
                   JOIN positions ps ON ps.user_id = f.followee_user_id AND ps.units > 0
                   LEFT JOIN characters ch ON ch.user_id = ps.user_id
                  WHERE f.follower_user_id = $1 AND ps.coin_id = ANY($2::uuid[])) x
               WHERE x.n <= 3`,
              [userId, launchCoins],
            )
          : { rows: [] },
      ])
    : [{ rows: [] }, { rows: [] }, { rows: [] }];
  const coinById = new Map(coins.rows.map((c) => [c.coin_id, c]));
  const verdictByCoin = new Map(verdicts.rows.map((v) => [v.coin_id, v]));
  const facesByCoin = new Map<string, { userId: string; alias: string }[]>();
  for (const f of followed.rows) {
    const list = facesByCoin.get(f.coin_id) ?? [];
    list.push({ userId: f.user_id, alias: f.alias });
    facesByCoin.set(f.coin_id, list);
  }

  return rows.map((r) => {
    const kind = normKind(r.kind);
    const coinId = coinIdOf(kind, r.meta);
    const coin = coinId ? coinById.get(coinId) : undefined;
    let card: ActionCard | null = null;
    if (coin) {
      card = {
        type: 'coin',
        coinId: coin.coin_id,
        ticker: coin.ticker,
        name: coin.name,
        stage: coin.stage,
        mcapCents: String(coin.mcap_cents),
        change5mBps: Number(coin.change_5m_bps),
        holders: Number(coin.holders),
        rugged: coin.rugged || coin.stage === 'dead',
        dead: coin.stage === 'dead',
        deepLink: `ctlife://coin/${coin.coin_id}`,
      };
    } else {
      const m = r.meta?.card as { type?: string; venueId?: string; userId?: string } | undefined;
      if (m?.type === 'venue' && m.venueId) card = venueCard(ctx, m.venueId);
      if (m?.type === 'profile' && m.userId) {
        card = {
          type: 'profile',
          userId: m.userId,
          alias: String(r.meta?.subjectAlias ?? ''),
          deepLink: `ctlife://profile/${m.userId}`,
        };
      }
    }
    const secondaryVenue =
      typeof r.meta?.venueId === 'string'
        ? r.meta.venueId
        : kind === 'sleuth' || kind === 'rug'
          ? 'launchpad_tower'
          : null;
    const v = coinId && kind !== 'sleuth' ? verdictByCoin.get(coinId) : undefined;
    return {
      postId: r.post_id,
      userId: r.user_id,
      alias: r.alias,
      text: r.text,
      createdAt: r.created_at.toISOString(),
      kind,
      isNpc: r.is_npc,
      district: r.district_slug,
      meta: r.meta,
      card,
      secondaryCard:
        secondaryVenue && card?.type !== 'venue' ? venueCard(ctx, secondaryVenue) : null,
      verdict: v
        ? { postId: v.post_id, text: v.text, sellSharePct: v.pct === null ? null : Number(v.pct) }
        : null,
      social:
        kind === 'launch' && coin
          ? { holders: Number(coin.holders), followed: facesByCoin.get(coin.coin_id) ?? [] }
          : null,
    };
  });
}

/** Insert a feed row inside a caller's transaction (city cards, callers). */
export async function insertSystemPost(
  client: Pick<PoolClient, 'query'>,
  p: {
    userId: string;
    kind: PostKind;
    text: string;
    meta: Record<string, unknown>;
    eventKey?: string | null;
    district?: string | null;
    at: Date;
  },
): Promise<string | null> {
  const postId = uuidv7();
  const r = await client.query(
    `INSERT INTO feed_posts (post_id, user_id, text, created_at, kind, meta, event_key, district_slug)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT DO NOTHING`,
    [
      postId,
      p.userId,
      p.text.slice(0, POST_TEXT_MAX),
      p.at,
      p.kind,
      JSON.stringify(p.meta),
      p.eventKey ?? null,
      p.district ?? null,
    ],
  );
  return (r.rowCount ?? 0) > 0 ? postId : null;
}
