/**
 * Payment poller (BullMQ, every 30 s; scheduled in main.ts).
 *
 * The Helius webhook is the fast path to credit a top-up. This poller is
 * the backstop: it reconciles open top-up and ad intents against finalized
 * chain data (reported signature + reference history), so a missed webhook
 * or an intent that was not final at `/submitted` still credits once. It
 * expires only what never reached the chain, expires unsigned intents of
 * other kinds, and ends ad bookings whose payment failed or whose run is
 * over. Crediting runs under a row lock with a ledger idempotency key, so
 * overlapping runs never credit twice.
 *
 * Talks to the real DB and the real Helius client (HELIUS_API_KEY).
 */
import type { Job } from 'bullmq';
import type { AppContext } from '../application/context.js';
import { expirePendingIntents, reconcileOpenIntents } from '../application/topup.js';
import { expireAdBookings } from '../application/ads.js';

export const PAYMENT_POLLER_QUEUE = 'jobs-payment-poller';

/**
 * BullMQ handler.
 * @param _job - The repeatable job (carries no data).
 * @param ctx - The app context.
 */
export async function handlePaymentPoller(_job: Job, ctx: AppContext): Promise<void> {
  const topups = await reconcileOpenIntents(ctx);
  if (topups.confirmed + topups.expired + topups.failed > 0) {
    console.info(
      `[payment-poller] top-ups confirmed=${topups.confirmed} expired=${topups.expired} failed=${topups.failed}`,
    );
  }
  const expired = await expirePendingIntents(ctx);
  if (expired > 0) console.info(`[payment-poller] expired ${expired} pending intent(s)`);
  const ads = await expireAdBookings(ctx);
  if (ads > 0) console.info(`[payment-poller] expired ${ads} ad booking(s)`);
}
