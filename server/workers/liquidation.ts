/**
 * Liquidation worker.
 *
 * Runs every 5 s. For each open perp, reads the engine's
 * `coins.price_micros` and closes the perp with
 * status='liquidated' if the price crosses `liq_micros`.
 *
 * The worker uses `liquidatePerp` (which is the only writer
 * of the perps row + the 'liq_pay' ledger row). The function
 * publishes a city room 'liquidated' event on Redis pub/sub
 * for the realtime layer to fan out to the user.
 */
import { buildContext } from '../application/context.js';
import { liquidatePerp } from '../application/perp-pit.js';

const POLL_INTERVAL_MS = 5_000;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/**
 * Start the liquidation worker. Returns a stop function.
 */
export function startLiquidationWorker(): () => void {
  if (timer !== null) return stopLiquidationWorker;
  const ctx = buildContext();
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const r = await ctx.db.withConnection(async (c) => {
        return c.query<{ perp_id: string; coin_id: string }>(
          `SELECT perp_id, coin_id FROM perps WHERE status = 'open' LIMIT 500`,
        );
      });
      for (const row of r.rows) {
        await liquidatePerp(ctx, row.perp_id);
      }
    } catch (e) {
      console.error('[liquidation] error:', (e as Error).message);
    } finally {
      running = false;
    }
  };
  timer = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
  return stopLiquidationWorker;
}

/** Stop the liquidation worker (idempotent). */
export function stopLiquidationWorker(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}

const isDirect = typeof process.argv[1] === 'string' && process.argv[1].endsWith('liquidation.ts');
if (isDirect) {
  startLiquidationWorker();
  process.on('SIGINT', () => {
    stopLiquidationWorker();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    stopLiquidationWorker();
    process.exit(0);
  });
}
