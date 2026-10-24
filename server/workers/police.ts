/**
 * Police referee: every 2 seconds start pursuits for wanted players, judge the
 * active ones from the server's position hash and timers, and release jail
 * stays whose timer ran out. See `application/heat.ts` and docs/HEAT.md.
 */
import type { Logger } from 'pino';
import type { AppContext } from '../application/context.js';
import { policeTick } from '../application/heat.js';

export const POLICE_TICK_MS = 2_000;

/**
 * Start the referee loop.
 * @param ctx - The application context.
 * @param log - A logger.
 * @returns A function that stops the loop.
 */
export function startPolice(ctx: AppContext, log: Logger): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    policeTick(ctx)
      .catch((e: unknown) => log.error({ err: (e as Error).message }, 'police tick failed'))
      .finally(() => {
        running = false;
      });
  }, POLICE_TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
