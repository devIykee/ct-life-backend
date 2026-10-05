/**
 * Alpha calls evaluator.
 *
 * Runs every 30 s. Calls `evaluateAlphaCalls` to resolve any
 * call whose target or stop has been hit, or whose 7-day
 * expiry has passed.
 */
import { buildContext } from '../application/context.js';
import { evaluateAlphaCalls } from '../application/alpha.js';

const POLL_INTERVAL_MS = 30_000;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/**
 * Start the alpha calls evaluator. Returns a stop function.
 */
export function startAlphaWorker(): () => void {
  if (timer !== null) return stopAlphaWorker;
  const ctx = buildContext();
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const n = await evaluateAlphaCalls(ctx);
      if (n > 0) console.info(`[alpha] resolved ${n} call(s)`);
    } catch (e) {
      console.error('[alpha] error:', (e as Error).message);
    } finally {
      running = false;
    }
  };
  timer = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
  return stopAlphaWorker;
}

/** Stop the alpha worker (idempotent). */
export function stopAlphaWorker(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}

const isDirect = typeof process.argv[1] === 'string' && process.argv[1].endsWith('alpha.ts');
if (isDirect) {
  startAlphaWorker();
  process.on('SIGINT', () => {
    stopAlphaWorker();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    stopAlphaWorker();
    process.exit(0);
  });
}
