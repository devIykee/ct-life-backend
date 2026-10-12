/**
 * Ads service (M5 #64).
 *
 * Endpoints:
 *
 *   GET  /v1/ads/live               - live creatives with a signed image URL;
 *                                       cache 5 minutes in Redis at
 *                                       ore:ads:live:{slotId}.
 *   GET  /v1/ads/slots              - slots, terms (USDC) and nextFreeAt.
 *   GET  /v1/ads/slots/{id}/availability - the window a new booking gets.
 *   POST /v1/uploads                - raw PNG/JPEG body (<= 1 MiB); decoded,
 *                                       re-encoded without metadata, stored
 *                                       at ads/{uploadId} and bound to the
 *                                       uploader in ad_uploads.
 *   POST /v1/ads/bookings           - reserve the slot's next window for an
 *                                       owned upload and return a server-
 *                                       priced USDC intent.
 *   GET  /v1/ads/bookings/{id}      - owner detail, incl. refund receipt.
 *   POST /v1/ads/bookings/{id}/cancel
 *   POST /v1/admin/ads/bookings/{id}/approve|reject|refund
 *
 * Lifecycle: awaiting_payment -> (verified payment, see topup.ts
 * reconcilePaymentIntent) pending_review -> live (admin) -> expired at the
 * window's end. Rejecting or cancelling a paid booking records an owed
 * refund; an admin records the refund transfer's signature. A booking whose
 * payment never arrives expires and frees the window.
 */
import { createHash } from 'node:crypto';
import sharp, { type Metadata } from 'sharp';
import { runInTransaction } from '../shared/db/uow.js';
import { ForbiddenError, NotFoundError, ValidationFailedError } from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { AppContext } from './context.js';
import { insertPreparedIntent, prepareUsdcIntent, type IntentResult } from './topup.js';

export interface AdSlot {
  readonly slotId: string;
  readonly kind: string;
  readonly terms: ReadonlyArray<{ termId: string; priceUsdc: number }>;
  readonly nextFreeAt: string | null;
}

export type AdBookingStatus =
  'awaiting_payment' | 'pending_review' | 'live' | 'rejected' | 'cancelled' | 'expired';

export interface AdBooking {
  readonly bookingId: string;
  readonly userId: string;
  readonly slotId: string;
  readonly termId: string;
  readonly uploadId: string;
  readonly link: string;
  readonly status: AdBookingStatus;
  readonly createdAt: string;
  readonly intentId: string | null;
  readonly priceCents: number | null;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly paidAt: string | null;
  readonly refund: { status: 'due' | 'refunded'; cents: number; signature: string | null } | null;
}

export interface AdCreative {
  readonly creativeId: string;
  readonly bookingId: string;
  readonly imageKey: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly uploadedAt: string;
}

export interface AdUpload {
  readonly uploadId: string;
  /** Same as uploadId; kept for clients written against the old shape. */
  readonly creativeId: string;
  readonly bookingId: '';
  readonly imageKey: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly uploadedAt: string;
  /** Short-lived signed URL of the stored image. */
  readonly url: string;
}

export interface LiveAd {
  readonly slotId: string;
  readonly bookingId: string;
  readonly link: string;
  readonly imageKey: string;
  readonly mimeType: string;
  readonly imageUrl: string;
  readonly sponsored: true;
  readonly endsAt: string | null;
}

const AD_LIVE_CACHE_TTL_SEC = 300;
/** Signed image URLs outlive the live cache so a cached entry stays usable. */
const IMAGE_URL_TTL_SEC = 3600;
const UPLOAD_URL_TTL_SEC = 900;
export const MAX_UPLOAD_BYTES = 1_048_576; // 1 MiB
const MAX_EDGE = 4096;
/** Booking statuses that hold a slot window. */
const HOLDING = ['awaiting_payment', 'pending_review', 'live'] as const;

interface SlotDbRow {
  slot_id: string;
  kind: string;
  terms: Record<string, number>;
  next_free_at: Date | null;
}

interface BookingDbRow {
  booking_id: string;
  user_id: string;
  slot_id: string;
  term_id: string;
  upload_id: string;
  link: string;
  status: AdBookingStatus;
  created_at: Date;
  intent_id: string | null;
  price_cents: string | null;
  starts_at: Date | null;
  ends_at: Date | null;
  paid_at: Date | null;
  refund_status: 'due' | 'refunded' | null;
  refund_cents: string | null;
  refund_signature: string | null;
}

const BOOKING_COLUMNS = `booking_id, user_id, slot_id, term_id, upload_id, link, status, created_at,
  intent_id, price_cents, starts_at, ends_at, paid_at, refund_status, refund_cents, refund_signature`;

interface CreativeDbRow {
  creative_id: string;
  booking_id: string;
  image_key: string;
  mime_type: string;
  size_bytes: number;
  uploaded_at: Date;
}

function rowToSlot(r: SlotDbRow): AdSlot {
  return {
    slotId: r.slot_id,
    kind: r.kind,
    terms: Object.entries(r.terms).map(([termId, priceUsdc]) => ({ termId, priceUsdc })),
    nextFreeAt: r.next_free_at ? r.next_free_at.toISOString() : null,
  };
}

function rowToBooking(r: BookingDbRow): AdBooking {
  return {
    bookingId: r.booking_id,
    userId: r.user_id,
    slotId: r.slot_id,
    termId: r.term_id,
    uploadId: r.upload_id,
    link: r.link,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    intentId: r.intent_id,
    priceCents: r.price_cents === null ? null : Number(r.price_cents),
    startsAt: r.starts_at ? r.starts_at.toISOString() : null,
    endsAt: r.ends_at ? r.ends_at.toISOString() : null,
    paidAt: r.paid_at ? r.paid_at.toISOString() : null,
    refund:
      r.refund_status === null
        ? null
        : {
            status: r.refund_status,
            cents: Number(r.refund_cents ?? '0'),
            signature: r.refund_signature,
          },
  };
}

function rowToCreative(r: CreativeDbRow): AdCreative {
  return {
    creativeId: r.creative_id,
    bookingId: r.booking_id,
    imageKey: r.image_key,
    mimeType: r.mime_type,
    sizeBytes: r.size_bytes,
    uploadedAt: r.uploaded_at.toISOString(),
  };
}

/** Term ids encode their length: `term_7d`, `term_30d`. */
export function termDurationMs(termId: string): number {
  const m = /^term_(\d{1,3})d$/.exec(termId);
  if (!m) throw new ValidationFailedError({ reason: `unknown term ${termId}` });
  const days = Number(m[1]);
  if (days < 1) throw new ValidationFailedError({ reason: `unknown term ${termId}` });
  return days * 24 * 60 * 60 * 1000;
}

/** Idempotently seed a few default ad_slots. */
export async function ensureAdSlots(ctx: AppContext): Promise<void> {
  const seed: ReadonlyArray<{ slotId: string; kind: string; terms: Record<string, number> }> = [
    { slotId: 'billboard_01', kind: 'billboard', terms: { term_7d: 20 } },
    { slotId: 'billboard_02', kind: 'billboard', terms: { term_7d: 20 } },
    { slotId: 'pixel_tile_001', kind: 'pixel_wall', terms: { term_7d: 2 } },
    { slotId: 'phone_app_01', kind: 'phone_app', terms: { term_30d: 150 } },
  ];
  for (const s of seed) {
    await ctx.db.withConnection(async (c) => {
      await c.query(
        `INSERT INTO ad_slots (slot_id, kind, terms) VALUES ($1, $2, $3)
         ON CONFLICT (slot_id) DO NOTHING`,
        [s.slotId, s.kind, s.terms],
      );
    });
  }
}

/** List slots; nextFreeAt is the start a booking made now would get. */
export async function listAdSlots(ctx: AppContext): Promise<AdSlot[]> {
  await ensureAdSlots(ctx);
  return ctx.db.withConnection(async (c) => {
    const r = await c.query<SlotDbRow>(
      `SELECT s.slot_id, s.kind, s.terms,
              (SELECT max(b.ends_at) FROM ad_bookings b
               WHERE b.slot_id = s.slot_id AND b.status = ANY($1) AND b.ends_at > now())
                AS next_free_at
       FROM ad_slots s ORDER BY s.slot_id ASC`,
      [HOLDING],
    );
    return r.rows.map(rowToSlot);
  });
}

/** The window and price a new booking on this slot+term would get now. */
export async function getSlotAvailability(
  ctx: AppContext,
  slotId: string,
  termId?: string,
): Promise<{
  slotId: string;
  available: boolean;
  nextStartAt: string;
  terms: ReadonlyArray<{ termId: string; priceUsdc: number; startsAt: string; endsAt: string }>;
}> {
  await ensureAdSlots(ctx);
  const r = await ctx.db.withConnection((c) =>
    c.query<SlotDbRow & { held_until: Date | null }>(
      `SELECT s.slot_id, s.kind, s.terms, s.next_free_at,
              (SELECT max(b.ends_at) FROM ad_bookings b
               WHERE b.slot_id = s.slot_id AND b.status = ANY($2) AND b.ends_at > now())
                AS held_until
       FROM ad_slots s WHERE s.slot_id = $1`,
      [slotId, HOLDING],
    ),
  );
  const slot = r.rows[0];
  if (!slot) throw new NotFoundError({ resource: 'ad_slot', id: slotId });
  const now = Date.now();
  const start = Math.max(now, slot.held_until?.getTime() ?? 0);
  const terms = Object.entries(slot.terms)
    .filter(([id]) => termId === undefined || id === termId)
    .map(([id, priceUsdc]) => ({
      termId: id,
      priceUsdc,
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(start + termDurationMs(id)).toISOString(),
    }));
  if (termId !== undefined && terms.length === 0) {
    throw new ValidationFailedError({ reason: `unknown term ${termId}` });
  }
  return {
    slotId,
    available: start <= now,
    nextStartAt: new Date(start).toISOString(),
    terms,
  };
}

/** List live ads for a slot, with a 5-minute Redis cache. */
export async function listLiveAdsForSlot(ctx: AppContext, slotId: string): Promise<LiveAd[]> {
  const cacheKey = `ore:ads:live:${slotId}`;
  const cached = await ctx.redis.main.get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached) as LiveAd[];
    } catch {
      void 0;
    }
  }
  const rows = await ctx.db.withConnection(async (c) => {
    const r = await c.query<{
      slot_id: string;
      booking_id: string;
      link: string;
      image_key: string;
      mime_type: string;
      ends_at: Date | null;
    }>(
      `SELECT b.slot_id, b.booking_id, b.link, cr.image_key, cr.mime_type, b.ends_at
       FROM ad_bookings b
       JOIN ad_creatives cr ON cr.booking_id = b.booking_id
       WHERE b.slot_id = $1 AND b.status = 'live'
         AND (b.starts_at IS NULL OR b.starts_at <= now())
         AND (b.ends_at IS NULL OR b.ends_at > now())
       ORDER BY b.created_at DESC LIMIT 50`,
      [slotId],
    );
    return r.rows;
  });
  const out: LiveAd[] = [];
  for (const row of rows) {
    out.push({
      slotId: row.slot_id,
      bookingId: row.booking_id,
      link: row.link,
      imageKey: row.image_key,
      mimeType: row.mime_type,
      imageUrl: await ctx.s3.presignGet(row.image_key, IMAGE_URL_TTL_SEC),
      sponsored: true,
      endsAt: row.ends_at ? row.ends_at.toISOString() : null,
    });
  }
  await ctx.redis.main.set(cacheKey, JSON.stringify(out), 'EX', AD_LIVE_CACHE_TTL_SEC);
  return out;
}

/** Live ads across every slot. */
export async function listLiveAds(ctx: AppContext): Promise<LiveAd[]> {
  const slots = await listAdSlots(ctx);
  const all: LiveAd[] = [];
  for (const s of slots) {
    const live = await listLiveAdsForSlot(ctx, s.slotId);
    all.push(...live);
  }
  return all;
}

/**
 * Decode a PNG/JPEG and re-encode it in the same format. Re-encoding drops
 * EXIF/ICC/text metadata and rejects anything that is not a real, bounded,
 * single-frame image of the declared type.
 */
async function normalizeCreative(bytes: Buffer, mimeType: 'image/png' | 'image/jpeg') {
  const format = mimeType === 'image/png' ? 'png' : 'jpeg';
  let meta: Metadata;
  try {
    meta = await sharp(bytes, { failOn: 'warning', limitInputPixels: MAX_EDGE * MAX_EDGE })
      .timeout({ seconds: 5 })
      .metadata();
  } catch {
    throw new ValidationFailedError({ reason: 'invalid image' });
  }
  if (
    meta.format !== format ||
    !meta.width ||
    !meta.height ||
    meta.width > MAX_EDGE ||
    meta.height > MAX_EDGE ||
    (meta.pages ?? 1) !== 1
  ) {
    throw new ValidationFailedError({ reason: 'image must be a single PNG/JPEG frame <= 4096px' });
  }
  const pipeline = sharp(bytes, { failOn: 'warning', limitInputPixels: MAX_EDGE * MAX_EDGE })
    .timeout({ seconds: 5 })
    .autoOrient();
  const out =
    format === 'png'
      ? await pipeline.png({ compressionLevel: 9 }).toBuffer()
      : await pipeline.jpeg({ quality: 90, mozjpeg: true }).toBuffer();
  if (out.length > MAX_UPLOAD_BYTES) {
    throw new ValidationFailedError({ reason: 'upload too large', maxBytes: MAX_UPLOAD_BYTES });
  }
  return out;
}

/**
 * Accept a creative upload from its raw bytes. The stored object and its
 * MIME, size and hash are bound to the uploader; a booking reads them from
 * here instead of trusting echoed metadata.
 */
export async function uploadCreative(
  ctx: AppContext,
  userId: string,
  args: { mimeType: string; bytes: Buffer; filename: string },
): Promise<AdUpload> {
  if (args.mimeType !== 'image/png' && args.mimeType !== 'image/jpeg') {
    throw new ValidationFailedError({ reason: 'mime must be image/png or image/jpeg' });
  }
  if (args.bytes.length === 0) {
    throw new ValidationFailedError({ reason: 'empty upload' });
  }
  if (args.bytes.length > MAX_UPLOAD_BYTES) {
    throw new ValidationFailedError({
      reason: 'upload too large',
      maxBytes: MAX_UPLOAD_BYTES,
      have: args.bytes.length,
    });
  }
  const stored = await normalizeCreative(args.bytes, args.mimeType);
  const uploadId = uuidv7();
  const ext = args.mimeType === 'image/png' ? 'png' : 'jpg';
  const key = `ads/${uploadId}.${ext}`;
  await putCreative(ctx, key, stored, args.mimeType);
  const sha256 = createHash('sha256').update(stored).digest('hex');
  const r = await ctx.db.withConnection((c) =>
    c.query<{ created_at: Date }>(
      `INSERT INTO ad_uploads (upload_id, user_id, image_key, mime_type, size_bytes, sha256)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING created_at`,
      [uploadId, userId, key, args.mimeType, stored.length, sha256],
    ),
  );
  return {
    uploadId,
    creativeId: uploadId,
    bookingId: '',
    imageKey: key,
    mimeType: args.mimeType,
    sizeBytes: stored.length,
    uploadedAt: r.rows[0]!.created_at.toISOString(),
    url: await ctx.s3.presignGet(key, UPLOAD_URL_TTL_SEC),
  };
}

/** Write to the ads bucket; create it only if the write says it is missing. */
async function putCreative(ctx: AppContext, key: string, bytes: Buffer, mime: string) {
  try {
    await ctx.s3.put(key, bytes, mime);
  } catch (e) {
    if ((e as { name?: string }).name !== 'NoSuchBucket') throw e;
    await ctx.s3.ensureBucket();
    await ctx.s3.put(key, bytes, mime);
  }
}

/**
 * Reserve the slot's next free window for an owned, unused upload and return
 * a server-priced USDC intent. The slot row lock makes concurrent bookings
 * queue one after another, so two bookings never share a window. The booking
 * waits in awaiting_payment until the payment is verified on chain.
 */
export async function bookAd(
  ctx: AppContext,
  userId: string,
  args: { slotId: string; termId: string; uploadId: string; link: string },
): Promise<{ booking: AdBooking; creative: AdCreative; intent: IntentResult }> {
  if (!/^https?:\/\/[^\s]{1,490}$/.test(args.link)) {
    throw new ValidationFailedError({ reason: 'link must be an http(s) URL up to 500 chars' });
  }
  const slotR = await ctx.db.withConnection((c) =>
    c.query<SlotDbRow>(
      `SELECT slot_id, kind, terms, next_free_at FROM ad_slots WHERE slot_id = $1`,
      [args.slotId],
    ),
  );
  const slot = slotR.rows[0];
  if (!slot) throw new NotFoundError({ reason: `unknown slot ${args.slotId}` });
  const priceUsdc = slot.terms[args.termId];
  if (priceUsdc === undefined || !Object.prototype.hasOwnProperty.call(slot.terms, args.termId)) {
    throw new ValidationFailedError({ reason: `unknown term ${args.termId}` });
  }
  const durationMs = termDurationMs(args.termId);
  const priceCents = Math.round(priceUsdc * 100);
  // Built outside the transaction (it fetches a blockhash); stored inside it.
  const prepared = await prepareUsdcIntent(ctx, {
    userId,
    kind: 'ad',
    amountBaseUnits: BigInt(priceCents) * 10_000n,
    cashCents: priceCents,
    bonusBps: 0,
    message: 'CT Life ad booking',
  });
  const bookingId = uuidv7();
  const creativeId = uuidv7();
  const result = await runInTransaction(async (client) => {
    await client.query(`SELECT slot_id FROM ad_slots WHERE slot_id = $1 FOR UPDATE`, [args.slotId]);
    const up = await client.query<{
      user_id: string;
      image_key: string;
      mime_type: string;
      size_bytes: number;
    }>(
      `SELECT user_id, image_key, mime_type, size_bytes FROM ad_uploads
       WHERE upload_id = $1 FOR UPDATE`,
      [args.uploadId],
    );
    const upload = up.rows[0];
    if (!upload || upload.user_id !== userId) {
      throw new NotFoundError({ resource: 'upload', id: args.uploadId });
    }
    const used = await client.query(
      `SELECT 1 FROM ad_bookings WHERE upload_id = $1 AND status <> ALL($2) LIMIT 1`,
      [args.uploadId, ['cancelled', 'expired', 'rejected']],
    );
    if ((used.rowCount ?? 0) > 0) {
      throw new ValidationFailedError({ reason: 'upload already booked' });
    }
    const held = await client.query<{ held_until: Date | null }>(
      `SELECT max(ends_at) AS held_until FROM ad_bookings
       WHERE slot_id = $1 AND status = ANY($2) AND ends_at > now()`,
      [args.slotId, HOLDING],
    );
    const startsAt = new Date(Math.max(Date.now(), held.rows[0]?.held_until?.getTime() ?? 0));
    const endsAt = new Date(startsAt.getTime() + durationMs);
    await insertPreparedIntent(client, prepared);
    const bR = await client.query<BookingDbRow>(
      `INSERT INTO ad_bookings
         (booking_id, user_id, slot_id, term_id, upload_id, link, status, intent_id,
          price_cents, starts_at, ends_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'awaiting_payment', $7, $8, $9, $10)
       RETURNING ${BOOKING_COLUMNS}`,
      [
        bookingId,
        userId,
        args.slotId,
        args.termId,
        args.uploadId,
        args.link,
        prepared.result.intentId,
        priceCents,
        startsAt.toISOString(),
        endsAt.toISOString(),
      ],
    );
    const cR = await client.query<CreativeDbRow>(
      `INSERT INTO ad_creatives (creative_id, booking_id, image_key, mime_type, size_bytes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING creative_id, booking_id, image_key, mime_type, size_bytes, uploaded_at`,
      [creativeId, bookingId, upload.image_key, upload.mime_type, upload.size_bytes],
    );
    return { booking: bR.rows[0]!, creative: cR.rows[0]! };
  });
  return {
    booking: rowToBooking(result.booking),
    creative: rowToCreative(result.creative),
    intent: prepared.result,
  };
}

/** Owner's view of one booking (404 for anyone else). */
export async function getBooking(
  ctx: AppContext,
  userId: string,
  bookingId: string,
): Promise<AdBooking> {
  const r = await ctx.db.withConnection((c) =>
    c.query<BookingDbRow>(`SELECT ${BOOKING_COLUMNS} FROM ad_bookings WHERE booking_id = $1`, [
      bookingId,
    ]),
  );
  const row = r.rows[0];
  if (!row || row.user_id !== userId)
    throw new NotFoundError({ resource: 'ad_booking', id: bookingId });
  return rowToBooking(row);
}

/**
 * Owner cancels before the ad is live. Unpaid: the window is released.
 * Paid: the window is released and the price is recorded as an owed refund.
 * A payment that lands after cancelling is also recorded as owed.
 */
export async function cancelBooking(
  _ctx: AppContext,
  userId: string,
  bookingId: string,
): Promise<AdBooking> {
  const row = await runInTransaction(async (client) => {
    const r = await client.query<BookingDbRow>(
      `SELECT ${BOOKING_COLUMNS} FROM ad_bookings WHERE booking_id = $1 FOR UPDATE`,
      [bookingId],
    );
    const b = r.rows[0];
    if (!b || b.user_id !== userId)
      throw new NotFoundError({ resource: 'ad_booking', id: bookingId });
    if (b.status === 'cancelled') return b;
    if (b.status !== 'awaiting_payment' && b.status !== 'pending_review') {
      throw new ForbiddenError({ reason: `cannot cancel a ${b.status} booking` });
    }
    const u = await client.query<BookingDbRow>(
      `UPDATE ad_bookings SET status = 'cancelled', decided_at = now(),
         refund_status = CASE WHEN paid_at IS NOT NULL THEN 'due' ELSE refund_status END,
         refund_cents = CASE WHEN paid_at IS NOT NULL THEN price_cents ELSE refund_cents END
       WHERE booking_id = $1 RETURNING ${BOOKING_COLUMNS}`,
      [bookingId],
    );
    return u.rows[0]!;
  });
  return rowToBooking(row);
}

/** Admin approval: only a paid booking in review can go live. */
export async function approveBooking(ctx: AppContext, bookingId: string): Promise<AdBooking> {
  const result = await runInTransaction(async (client) => {
    const r = await client.query<BookingDbRow>(
      `UPDATE ad_bookings SET status = 'live', decided_at = now()
       WHERE booking_id = $1 AND status = 'pending_review'
         AND (intent_id IS NULL OR paid_at IS NOT NULL)
       RETURNING ${BOOKING_COLUMNS}`,
      [bookingId],
    );
    if (!r.rows[0]) {
      throw new NotFoundError({ reason: 'booking not paid and pending_review' });
    }
    return r.rows[0];
  });
  // Invalidate the live cache for the slot.
  await ctx.redis.main.del(`ore:ads:live:${result.slot_id}`);
  return rowToBooking(result);
}

/** Admin rejection; a paid booking records its price as an owed refund. */
export async function rejectBooking(_ctx: AppContext, bookingId: string): Promise<AdBooking> {
  const result = await runInTransaction(async (client) => {
    const r = await client.query<BookingDbRow>(
      `UPDATE ad_bookings SET status = 'rejected', decided_at = now(),
         refund_status = CASE WHEN paid_at IS NOT NULL THEN 'due' ELSE refund_status END,
         refund_cents = CASE WHEN paid_at IS NOT NULL THEN price_cents ELSE refund_cents END
       WHERE booking_id = $1 AND status = 'pending_review'
       RETURNING ${BOOKING_COLUMNS}`,
      [bookingId],
    );
    if (!r.rows[0]) {
      throw new NotFoundError({ reason: 'booking not pending_review' });
    }
    return r.rows[0];
  });
  return rowToBooking(result);
}

/**
 * Admin records the USDC refund transfer for an owed refund. Idempotent for
 * the same signature; the receipt is visible on the owner's booking.
 */
export async function recordRefund(
  _ctx: AppContext,
  bookingId: string,
  signature: string,
): Promise<AdBooking> {
  const result = await runInTransaction(async (client) => {
    const r = await client.query<BookingDbRow>(
      `SELECT ${BOOKING_COLUMNS} FROM ad_bookings WHERE booking_id = $1 FOR UPDATE`,
      [bookingId],
    );
    const b = r.rows[0];
    if (!b) throw new NotFoundError({ resource: 'ad_booking', id: bookingId });
    if (b.refund_status === 'refunded' && b.refund_signature === signature) return b;
    if (b.refund_status !== 'due') {
      throw new ValidationFailedError({ reason: 'no refund owed' });
    }
    const u = await client.query<BookingDbRow>(
      `UPDATE ad_bookings SET refund_status = 'refunded', refund_signature = $2
       WHERE booking_id = $1 RETURNING ${BOOKING_COLUMNS}`,
      [bookingId, signature],
    );
    return u.rows[0]!;
  });
  return rowToBooking(result);
}

/**
 * Poller pass: unpaid bookings whose intent expired free their window; live
 * bookings past their window end. Returns the number of bookings changed.
 */
export async function expireAdBookings(ctx: AppContext): Promise<number> {
  const r = await ctx.db.withConnection((c) =>
    c.query<{ slot_id: string }>(
      `UPDATE ad_bookings b SET status = 'expired'
       FROM payment_intents p
       WHERE (b.status = 'awaiting_payment' AND p.intent_id = b.intent_id
              AND p.status IN ('expired', 'failed'))
          OR (b.status = 'live' AND b.ends_at IS NOT NULL AND b.ends_at <= now()
              AND p.intent_id = b.intent_id)
       RETURNING b.slot_id`,
    ),
  );
  for (const slot of new Set(r.rows.map((x) => x.slot_id))) {
    await ctx.redis.main.del(`ore:ads:live:${slot}`);
  }
  return r.rowCount ?? 0;
}

/** List bookings for the calling user. */
export async function listMyBookings(
  ctx: AppContext,
  userId: string,
  limit: number,
): Promise<AdBooking[]> {
  const lim = Math.min(Math.max(1, limit), 200);
  return ctx.db.withConnection(async (c) => {
    const r = await c.query<BookingDbRow>(
      `SELECT ${BOOKING_COLUMNS}
       FROM ad_bookings WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, lim],
    );
    return r.rows.map(rowToBooking);
  });
}
