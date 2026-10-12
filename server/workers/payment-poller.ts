/**
 * Payment poller.
 *
 * The Helius webhook is the fast path to credit a topup. This
 * poller is the backstop: every 30 s it reconciles open top-ups
 * against finalized chain data (reported signature + reference
 * history), so a missed webhook still credits once, and expires
 * only what never reached the chain.
 *
 * No mocks: this worker talks to the real DB and the real
 * Helius client.
 */
import { buildContext } from '../application/context.js';
import { expirePendingIntents, reconcileOpenIntents } from '../application/topup.js';
import { expireAdBookings } from '../application/ads.js';

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
      const topups = await reconcileOpenIntents(ctx);
      if (topups.confirmed + topups.expired + topups.failed > 0) {
        console.info(
          `[payment-poller] top-ups confirmed=${topups.confirmed} expired=${topups.expired} failed=${topups.failed}`,
        );
      }
      const expired = await expirePendingIntents(ctx);
      if (expired > 0) {
        console.info(`[payment-poller] expired ${expired} pending intent(s)`);
      }
      const ads = await expireAdBookings(ctx);
      if (ads > 0) {
        console.info(`[payment-poller] expired ${ads} ad booking(s)`);
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
