/**
 * Payment poller.
 *
 * The Helius webhook is the primary path to credit a topup.
 * This poller is a backstop: it expires any pending intent
 * older than 15 minutes. It runs every 30 s.
 *
 * No mocks: this worker talks to the real DB and the real
 * Helius client.
 */
import { buildContext } from '../application/context.js';
import { expirePendingIntents } from '../application/topup.js';

const POLL_INTERVAL_MS = 30_000;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/**
 * Start the payment poller. Returns a stop function.
 */
export function startPaymentPoller(): () => void {
  if (timer !== null) return stopPaymentPoller;
  const ctx = buildContext();
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const expired = await expirePendingIntents(ctx);
      if (expired > 0) {
        console.info(`[payment-poller] expired ${expired} pending intent(s)`);
      }
    } catch (e) {
      console.error('[payment-poller] error:', (e as Error).message);
    } finally {
      running = false;
    }
  };
  timer = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
  return stopPaymentPoller;
}

/** Stop the poller (idempotent). */
export function stopPaymentPoller(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}

const isDirect =
  typeof process.argv[1] === 'string' && process.argv[1].endsWith('payment-poller.ts');
if (isDirect) {
  startPaymentPoller();
  process.on('SIGINT', () => {
    stopPaymentPoller();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    stopPaymentPoller();
    process.exit(0);
  });
}
