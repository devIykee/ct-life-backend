/**
 * Ads service (Phase 5 prep).
 *
 *   GET  /v1/ads/live    — list live ad slots (cache 5 min).
 *                          Phase 5 fills the creatives; M4 returns
 *                          the slot registry.
 *   GET  /v1/ads/slots   — list all slots with terms + nextFreeAt.
 *   POST /v1/ads/bookings — book a slot (Phase 5 — M4 accepts the
 *                          input shape and writes a stub booking row).
 *
 * Real ad creative delivery ships in Phase 5; the M4 slice
 * registers the endpoints and the meta + booking table layout.
 */
import { runInTransaction } from '../shared/db/uow.js';
import { ValidationFailedError } from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { AppContext } from './context.js';

export interface AdSlot {
  readonly slotId: string;
  readonly kind: string;
  readonly terms: ReadonlyArray<{ termId: string; priceUsdc: number }>;
  readonly nextFreeAt: string | null;
}

export interface AdBooking {
  readonly bookingId: string;
  readonly slotId: string;
  readonly termId: string;
  readonly uploadId: string;
  readonly link: string;
  readonly status: 'pending_review' | 'live' | 'rejected';
  readonly createdAt: string;
}

const AD_SLOTS: AdSlot[] = [
  {
    slotId: 'billboard_01',
    kind: 'billboard',
    terms: [{ termId: 'term_7d', priceUsdc: 20 }],
    nextFreeAt: null,
  },
  {
    slotId: 'billboard_02',
    kind: 'billboard',
    terms: [{ termId: 'term_7d', priceUsdc: 20 }],
    nextFreeAt: null,
  },
  {
    slotId: 'pixel_tile_001',
    kind: 'pixel_wall',
    terms: [{ termId: 'term_7d', priceUsdc: 2 }],
    nextFreeAt: null,
  },
  {
    slotId: 'phone_app_01',
    kind: 'phone_app',
    terms: [{ termId: 'term_30d', priceUsdc: 150 }],
    nextFreeAt: null,
  },
];

/**
 *
 */
export async function listAdSlots(): Promise<AdSlot[]> {
  return AD_SLOTS.map((s) => ({ ...s }));
}

/** Live ad slots (M4 returns the same list; Phase 5 joins creatives). */
export async function listLiveAds(_ctx: AppContext): Promise<AdSlot[]> {
  return AD_SLOTS.map((s) => ({ ...s }));
}

/** Book a slot. Phase 5 wires the payment_intent + creative upload. */
export async function bookAd(
  _ctx: AppContext,
  userId: string,
  args: { slotId: string; termId: string; uploadId: string; link: string },
): Promise<AdBooking> {
  const slot = AD_SLOTS.find((s) => s.slotId === args.slotId);
  if (!slot) throw new ValidationFailedError({ reason: `unknown slot ${args.slotId}` });
  if (!slot.terms.find((t) => t.termId === args.termId)) {
    throw new ValidationFailedError({ reason: `unknown term ${args.termId}` });
  }
  if (args.link.length < 1 || args.link.length > 500) {
    throw new ValidationFailedError({ reason: 'link length 1..500' });
  }
  const bookingId = uuidv7();
  await runInTransaction(async (client) => {
    await client.query(
      `CREATE TABLE IF NOT EXISTS ad_bookings (
         booking_id uuid PRIMARY KEY,
         user_id uuid NOT NULL,
         slot_id text NOT NULL,
         term_id text NOT NULL,
         upload_id text NOT NULL,
         link text NOT NULL,
         status text NOT NULL DEFAULT 'pending_review'
                  CHECK (status IN ('pending_review', 'live', 'rejected')),
         created_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    await client.query(
      `INSERT INTO ad_bookings
         (booking_id, user_id, slot_id, term_id, upload_id, link)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [bookingId, userId, args.slotId, args.termId, args.uploadId, args.link],
    );
  });
  return {
    bookingId,
    slotId: args.slotId,
    termId: args.termId,
    uploadId: args.uploadId,
    link: args.link,
    status: 'pending_review',
    createdAt: new Date().toISOString(),
  };
}
