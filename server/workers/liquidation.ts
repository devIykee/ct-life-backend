/**
 * Liquidation sweep (BullMQ, every 5 s; scheduled in main.ts).
 *
 * Finds open perps whose coin's `coins.price_micros` has crossed
 * `liq_micros` and closes each with status='liquidated' through
 * `liquidatePerp`, the only writer of the perps row and its 'liq_pay'
 * ledger row. That function re-checks the cross under row locks and
 * publishes the city room 'liquidated' event, so a second replica or an
 * overlapping run closes nothing twice.
 *
 * The SQL pre-filter keeps the sweep from taking a coin row lock for every
 * open perp every 5 s (the market engine writes those rows on each tick).
 */
import type { Job } from 'bullmq';
import type { AppContext } from '../application/context.js';
import { liquidatePerp } from '../application/perp-pit.js';

export const LIQUIDATION_QUEUE = 'jobs-liquidation';

/** Most perps one sweep closes; the next sweep picks up the rest. */
const BATCH = 500;

/**
 * BullMQ handler.
 * @param _job - The repeatable job (carries no data).
 * @param ctx - The app context.
 * @returns How many perps were liquidated.
 */
export async function handleLiquidation(_job: Job, ctx: AppContext): Promise<number> {
  const r = await ctx.db.withConnection((c) =>
    c.query<{ perp_id: string }>(
      `SELECT p.perp_id
         FROM perps p JOIN coins c ON c.coin_id = p.coin_id
        WHERE p.status = 'open'
          AND ((p.side = 'long' AND c.price_micros <= p.liq_micros)
            OR (p.side = 'short' AND c.price_micros >= p.liq_micros))
        ORDER BY p.created_at
        LIMIT $1`,
      [BATCH],
    ),
  );
  let liquidated = 0;
  for (const row of r.rows) {
    try {
      if (await liquidatePerp(ctx, row.perp_id)) liquidated += 1;
    } catch (e) {
      // One bad perp must not stop the sweep; the next sweep retries it.
      console.error(`[liquidation] perp ${row.perp_id} failed:`, (e as Error).message);
    }
  }
  if (liquidated > 0) console.info(`[liquidation] liquidated ${liquidated} perp(s)`);
  return liquidated;
}
