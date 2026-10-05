/**
 * Prediction resolution worker.
 *
 * Runs every 5 s. Resolves all open predictions whose
 * closes_at is in the past. Calls `resolveClosedPredictions`
 * (in server/application/predictions.ts).
 */
import { buildContext } from '../application/context.js';
import { resolveClosedPredictions } from '../application/predictions.js';

const POLL_INTERVAL_MS = 5_000;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/**
 * Start the prediction resolution worker. Returns a stop function.
 */
export function startPredictionWorker(): () => void {
  if (timer !== null) return stopPredictionWorker;
  const ctx = buildContext();
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const n = await resolveClosedPredictions(ctx);
      if (n > 0) console.info(`[predictions] resolved ${n}`);
    } catch (e) {
      console.error('[predictions] error:', (e as Error).message);
    } finally {
      running = false;
    }
  };
  timer = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
  return stopPredictionWorker;
}

/** Stop the prediction worker (idempotent). */
export function stopPredictionWorker(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}

const isDirect = typeof process.argv[1] === 'string' && process.argv[1].endsWith('predictions.ts');
if (isDirect) {
  startPredictionWorker();
  process.on('SIGINT', () => {
    stopPredictionWorker();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    stopPredictionWorker();
    process.exit(0);
  });
}
