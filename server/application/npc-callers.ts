/**
 * NPC callers on the Timeline (board timeline-36, decision D3).
 *
 * Four original parody characters (no real CT account, name or likeness)
 * post calls on house coins only, each on their own schedule (every 45 to
 * 120 minutes, jittered). The call carries a coin card and the numbers
 * (entry, target, stop); whether it works out is up to the market engine's
 * hidden arcs, so callers are sometimes right and sometimes very wrong.
 * Following a caller fills your Following tab on a quiet day.
 *
 * The workers run `runNpcCallers` every 5 minutes; the next due time per
 * caller lives in Redis, so a restart does not make everyone post at once.
 */
import type { AppContext } from './context.js';
import { insertSystemPost } from './timeline.js';

export interface CallerPersona {
  readonly slug: string;
  readonly userId: string;
  /** Typical target multiple and stop, before jitter. */
  readonly targetX: [number, number];
  readonly stopPct: [number, number];
  /** {T} ticker, {X} target, {S} stop. */
  readonly lines: readonly string[];
}

export const CALLERS: readonly CallerPersona[] = [
  {
    slug: 'candle_carla',
    userId: '00000000-0000-4000-8000-0000000ca101',
    targetX: [1.5, 3],
    stopPct: [15, 25],
    lines: [
      '$T breaking out of the wedge. entry here, target {X}x, stop -{S}%. NFA',
      '$T retesting support like a textbook. target {X}x, invalidation -{S}%.',
      'drew three lines on $T and they all point up. {X}x, stop -{S}%.',
    ],
  },
  {
    slug: 'rugwatch_ray',
    userId: '00000000-0000-4000-8000-0000000ca102',
    targetX: [1.3, 2],
    stopPct: [8, 15],
    lines: [
      '$T: dev wallet quiet so far. small bag, tight stop -{S}%, target {X}x.',
      'checked $T holders twice. looks clean. still a -{S}% stop. trust nobody.',
      '$T is the least suspicious thing on the board today. {X}x if it holds.',
    ],
  },
  {
    slug: 'moonboy_milo',
    userId: '00000000-0000-4000-8000-0000000ca103',
    targetX: [5, 20],
    stopPct: [40, 60],
    lines: [
      '$T TO THE MOON. {X}x minimum. stops are for cowards (ok fine, -{S}%)',
      'if you are not in $T you will be priced out forever. {X}x incoming',
      '$T is the one. I can feel it. {X}x. this is not advice, it is destiny',
    ],
  },
  {
    slug: 'auntie_ape',
    userId: '00000000-0000-4000-8000-0000000ca104',
    targetX: [2, 6],
    stopPct: [30, 50],
    lines: [
      'aped $T because the logo is cute. target {X}x. stop? -{S}% I guess',
      'bought $T before reading anything. vibes are {X}x. love you all',
      'my nephew said $T so I am in. {X}x or -{S}%, either way we eat',
    ],
  },
];

const MIN_GAP_MS = 45 * 60_000;
const MAX_GAP_MS = 120 * 60_000;
const nextKey = (slug: string): string => `tl:caller:${slug}:next`;

function between(rng: () => number, [a, b]: readonly [number, number]): number {
  return a + (b - a) * rng();
}

/**
 * Let every caller whose turn has come post one call on a live house coin.
 * @param ctx - The app context.
 * @param now - Current time.
 * @param rng - Randomness (injectable for tests).
 * @returns How many calls were posted.
 */
export async function runNpcCallers(
  ctx: AppContext,
  now: Date = new Date(),
  rng: () => number = Math.random,
): Promise<number> {
  let posted = 0;
  for (const p of CALLERS) {
    const due = Number((await ctx.redis.main.get(nextKey(p.slug))) ?? 0);
    if (due === 0) {
      // First run: spread the callers out instead of posting all at once.
      await ctx.redis.main.set(nextKey(p.slug), String(now.getTime() + rng() * MAX_GAP_MS));
      continue;
    }
    if (now.getTime() < due) continue;
    await ctx.redis.main.set(
      nextKey(p.slug),
      String(now.getTime() + MIN_GAP_MS + rng() * (MAX_GAP_MS - MIN_GAP_MS)),
    );
    const coin = await ctx.db.withConnection((c) =>
      c.query<{ coin_id: string; ticker: string; price_micros: string }>(
        `SELECT coin_id, ticker, price_micros FROM coins
          WHERE NOT player_launched AND stage IN ('new', 'final', 'graduated')
          ORDER BY random() LIMIT 1`,
      ),
    );
    const c = coin.rows[0];
    if (!c) continue;
    const targetX = Math.round(between(rng, p.targetX) * 10) / 10;
    const stopPct = Math.round(between(rng, p.stopPct));
    const line = p.lines[Math.floor(rng() * p.lines.length)]!;
    const text = line
      .replaceAll('$T', () => `$${c.ticker}`)
      .replaceAll('{X}', () => String(targetX))
      .replaceAll('{S}', () => String(stopPct));
    const id = await ctx.db.withConnection((db) =>
      insertSystemPost(db, {
        userId: p.userId,
        kind: 'caller',
        text,
        meta: {
          persona: p.slug,
          coinId: c.coin_id,
          ticker: c.ticker,
          call: { entryMicros: c.price_micros, targetX, stopPct },
          card: { type: 'coin', coinId: c.coin_id },
        },
        at: now,
      }),
    );
    if (id) posted++;
  }
  return posted;
}
