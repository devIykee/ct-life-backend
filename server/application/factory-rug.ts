/**
 * Rugpull Factory: what happens after a trade of a player-launched coin.
 *
 *   recordFactoryTrade  (inside the trade transaction)
 *     - logs the trade in `factory_trades`;
 *     - once the coin has mooned (price at or above 3x its launch price),
 *       pays the creator a share of the trade fee, ledger `factory_creator_fee`.
 *       The fee is carved out of the fee the market already charges, so the
 *       payout is never new money. The creator's own trades earn nothing.
 *
 *   checkCreatorRug     (after the trade commits)
 *     - a rug is the creator selling at least RUG_SELL_BPS of the coin's
 *       circulating units inside RUG_WINDOW_MS while other players bought at
 *       least RUG_MIN_HOLDER_BUY_CENTS in that window;
 *     - it flags the coin once, adds heat to the creator, posts one Sleuth
 *       exposé to the Timeline (rate limited) and announces `evt_rug`.
 */
import type { PoolClient } from 'pg';
import { runInTransaction } from '../shared/db/uow.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { AppContext } from './context.js';
import { isBlockedText } from './factory-filter.js';
import { addHeat } from './player-heat.js';
import { publishWorldEvent } from './realtime-bus.js';

/** The Sleuth's author id (seeded by migration 089). */
export const SLEUTH_USER_ID = '00000000-0000-4000-8000-0000000051e7';
export const SLEUTH_ALIAS = 'The Sleuth';

/** Price multiple (basis points of the launch price) that counts as mooning. */
export const MOON_MULTIPLE_BPS = 30_000;
/** Share of each trade fee the creator earns once the coin has mooned. */
export const CREATOR_FEE_SHARE_BPS = 5_000;

export const RUG_WINDOW_MS = 60 * 60 * 1000;
export const RUG_SELL_BPS = 3_000;
export const RUG_MIN_HOLDER_BUY_CENTS = 500;
export const RUG_HEAT_BASE = 35;
export const RUG_HEAT_SHARE_BONUS = 15;
/** One exposé per launcher in this window; the rug is still flagged and heated. */
export const SLEUTH_LAUNCHER_COOLDOWN_MS = 30 * 60 * 1000;

export interface FactoryTradeRecord {
  readonly coinId: string;
  readonly userId: string;
  readonly side: 'buy' | 'sell';
  readonly units: bigint;
  /** Net cash moved: debited on a buy (fee included), credited on a sell (fee deducted). */
  readonly cashCents: bigint;
  readonly feeCents: bigint;
  readonly priceMicros: bigint;
}

/**
 * Log a trade of a player coin and pay the creator fee. Runs in the trade's
 * transaction.
 * @param client - The trade transaction's client.
 * @param t - The trade.
 */
export async function recordFactoryTrade(client: PoolClient, t: FactoryTradeRecord): Promise<void> {
  await client.query(
    `INSERT INTO factory_trades (coin_id, user_id, side, units, cash_cents, fee_cents, price_micros)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      t.coinId,
      t.userId,
      t.side,
      t.units.toString(),
      t.cashCents.toString(),
      t.feeCents.toString(),
      t.priceMicros.toString(),
    ],
  );
  const f = await client.query<{
    creator_id: string;
    launch_price_micros: string;
    mooned_at: Date | null;
  }>(
    `SELECT creator_id, launch_price_micros, mooned_at
       FROM factory_coins WHERE coin_id = $1 FOR UPDATE`,
    [t.coinId],
  );
  const row = f.rows[0];
  if (!row) return;
  let mooned = row.mooned_at !== null;
  if (
    !mooned &&
    t.priceMicros * 10_000n >= BigInt(row.launch_price_micros) * BigInt(MOON_MULTIPLE_BPS)
  ) {
    await client.query(`UPDATE factory_coins SET mooned_at = now() WHERE coin_id = $1`, [t.coinId]);
    mooned = true;
  }
  if (!mooned || t.userId === row.creator_id) return;
  const share = (t.feeCents * BigInt(CREATOR_FEE_SHARE_BPS)) / 10_000n;
  if (share <= 0n) return;
  await client.query(
    `INSERT INTO balances (user_id, cash_cents) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET cash_cents = balances.cash_cents + $2, updated_at = now()`,
    [row.creator_id, share.toString()],
  );
  await client.query(
    `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
     VALUES ($1, $2, 'cash', 'factory_creator_fee', 'coin', $3, $4)`,
    [row.creator_id, share.toString(), t.coinId, `factory-fee:${t.coinId}:${uuidv7()}`],
  );
  await client.query(
    `UPDATE factory_coins SET creator_fees_cents = creator_fees_cents + $2 WHERE coin_id = $1`,
    [t.coinId, share.toString()],
  );
}

const TEMPLATES: ReadonlyArray<
  (v: { alias: string; ticker: string; pct: number; buyers: number; heat: number }) => string
> = [
  (v) =>
    `Followed the money on $${v.ticker}. ${v.alias} seeded it, let ${v.buyers} wallet${v.buyers === 1 ? '' : 's'} ape in, then walked off with ${v.pct}% of the float. Heat on ${v.alias}: ${v.heat}.`,
  (v) =>
    `Case file: $${v.ticker}. The dev, ${v.alias}, sold ${v.pct}% of the supply straight into the people who just bought. I do not call it a rug. The ledger does. Heat: ${v.heat}.`,
  (v) =>
    `Receipts for $${v.ticker} holders: ${v.alias} dumped ${v.pct}% right after ${v.buyers} of you bought in. Pattern noted, name logged, heat now ${v.heat}.`,
  (v) =>
    `$${v.ticker} did not die of natural causes. ${v.alias} cashed out ${v.pct}% while the chart was still green. I keep a list of devs like this. They run hot at ${v.heat}.`,
  (v) =>
    `Quiet day at the desk until ${v.alias} unloaded ${v.pct}% of $${v.ticker} on ${v.buyers} fresh buyer${v.buyers === 1 ? '' : 's'}. Filing it. Heat on the dev: ${v.heat}.`,
  (v) =>
    `Public service note. $${v.ticker} dev ${v.alias} exited ${v.pct}% of the coin the minute liquidity showed up. Check who you ape for. Their heat reads ${v.heat}.`,
];

/**
 * Sleuth exposé text. Pure; the variant is picked from the coin id so a coin
 * always reads the same but different coins read differently.
 * @param seed - Usually the coin id.
 * @param v - The facts.
 */
export function sleuthPostText(
  seed: string,
  v: { alias: string; ticker: string; pct: number; buyers: number; heat: number },
): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const alias = isBlockedText(v.alias) ? 'a masked dev' : v.alias;
  const text = TEMPLATES[h % TEMPLATES.length]!({ ...v, alias });
  return text.length <= 280 ? text : `${text.slice(0, 277)}...`;
}

export interface RugResult {
  readonly flagged: boolean;
  readonly heat: number;
  readonly postId: string | null;
  readonly sellSharePct: number;
}

/**
 * After a creator sell: decide whether it was a rug and, if so, flag it once.
 * @param ctx - The application context.
 * @param coinId - The coin.
 * @param userId - The seller.
 * @param now - The current time (injectable for tests).
 * @returns The result, or null when this sell is not a rug.
 */
export async function checkCreatorRug(
  ctx: AppContext,
  coinId: string,
  userId: string,
  now: Date = new Date(),
): Promise<RugResult | null> {
  const out = await runInTransaction(async (client) => {
    const f = await client.query<{
      creator_id: string;
      rug_flagged_at: Date | null;
      ticker: string;
    }>(
      `SELECT f.creator_id, f.rug_flagged_at, c.ticker
         FROM factory_coins f JOIN coins c ON c.coin_id = f.coin_id
        WHERE f.coin_id = $1 FOR UPDATE OF f`,
      [coinId],
    );
    const coin = f.rows[0];
    if (!coin || coin.creator_id !== userId || coin.rug_flagged_at !== null) return null;

    const since = new Date(now.getTime() - RUG_WINDOW_MS);
    const s = await client.query<{ sold: string; buy_cents: string; buyers: string }>(
      `SELECT COALESCE(SUM(units) FILTER (WHERE user_id = $2 AND side = 'sell'), 0)::text AS sold,
              COALESCE(SUM(cash_cents) FILTER (WHERE user_id <> $2 AND side = 'buy'), 0)::text AS buy_cents,
              COUNT(DISTINCT user_id) FILTER (WHERE user_id <> $2 AND side = 'buy')::text AS buyers
         FROM factory_trades WHERE coin_id = $1 AND at > $3`,
      [coinId, userId, since],
    );
    const circ = await client.query<{ units: string }>(
      `SELECT COALESCE(SUM(units), 0)::text AS units FROM positions WHERE coin_id = $1 AND units > 0`,
      [coinId],
    );
    const sold = BigInt(s.rows[0]!.sold);
    const buyCents = BigInt(s.rows[0]!.buy_cents);
    const buyers = Number(s.rows[0]!.buyers);
    const before = BigInt(circ.rows[0]!.units) + sold; // circulating before the dump
    if (sold <= 0n || before <= 0n) return null;
    const shareBps = Number((sold * 10_000n) / before);
    if (shareBps < RUG_SELL_BPS || buyers < 1 || buyCents < BigInt(RUG_MIN_HOLDER_BUY_CENTS)) {
      return null;
    }

    await client.query(`UPDATE factory_coins SET rug_flagged_at = $2 WHERE coin_id = $1`, [
      coinId,
      now,
    ]);
    const delta = RUG_HEAT_BASE + Math.round((shareBps * RUG_HEAT_SHARE_BONUS) / 10_000);
    const heat = Math.round(await addHeat(client, userId, delta, 'factory_rug', coinId, now));
    const al = await client.query<{ alias: string | null }>(
      `SELECT alias FROM characters WHERE user_id = $1`,
      [userId],
    );
    const alias = al.rows[0]?.alias ?? 'an anonymous dev';
    const pct = Math.round(shareBps / 100);

    // Rate limit: one exposé per launcher per cooldown. The unique index on
    // meta.coinId makes it one per coin even under a race.
    const recent = await client.query(
      `SELECT 1 FROM feed_posts
        WHERE kind = 'sleuth' AND meta ->> 'launcherUserId' = $1 AND created_at > $2 LIMIT 1`,
      [userId, new Date(now.getTime() - SLEUTH_LAUNCHER_COOLDOWN_MS)],
    );
    let postId: string | null = null;
    if ((recent.rowCount ?? 0) === 0) {
      const id = uuidv7();
      const text = sleuthPostText(coinId, { alias, ticker: coin.ticker, pct, buyers, heat });
      const ins = await client.query(
        `INSERT INTO feed_posts (post_id, user_id, text, created_at, kind, meta)
         VALUES ($1, $2, $3, $4, 'sleuth', $5)
         ON CONFLICT DO NOTHING`,
        [
          id,
          SLEUTH_USER_ID,
          text,
          now,
          JSON.stringify({
            coinId,
            ticker: coin.ticker,
            launcherUserId: userId,
            launcherAlias: alias,
            sellSharePct: pct,
            heat,
            deepLink: 'venue:launchpad_tower',
          }),
        ],
      );
      if ((ins.rowCount ?? 0) > 0) postId = id;
    }
    return { ticker: coin.ticker, alias, heat, postId, pct };
  });
  if (!out) return null;
  await publishWorldEvent(ctx, 'evt_rug', {
    coinId,
    ticker: out.ticker,
    kind: 'creator_dump',
    launcherAlias: out.alias,
    heat: String(out.heat),
  });
  return { flagged: true, heat: out.heat, postId: out.postId, sellSharePct: out.pct };
}
