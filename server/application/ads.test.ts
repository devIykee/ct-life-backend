/**
 * Ads service tests.
 *
 * Covers: slot listing (with idempotent seed), creative
 * upload validation (mime + size), booking creation with
 * ad_creatives row, listing live ads (no live yet), admin
 * approve + reject flows with Redis cache invalidation,
 * unknown slot / term / booking refused.
 */
import { Pool } from 'pg';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config as loadDotenv } from 'dotenv';

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { NotFoundError, ValidationFailedError } from '../shared/domain/errors.js';

loadDotenv({ path: process.cwd() + '/.env' });

_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let userId: string;

beforeAll(async () => {
  userId = uuidv7();
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [userId, `adsUser-${userId}`]);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  // Reset bookings + creatives; leave the seeded slots in place.
  await pool.query(
    `DELETE FROM ad_creatives WHERE booking_id IN
       (SELECT booking_id FROM ad_bookings WHERE user_id = $1)`,
    [userId],
  );
  await pool.query(`DELETE FROM ad_bookings WHERE user_id = $1`, [userId]);
  // Clear the live-ads cache for every slot.
  const ctx = buildContext();
  const slots = await ctx.db.withConnection((c) =>
    c.query<{ slot_id: string }>(`SELECT slot_id FROM ad_slots`),
  );
  for (const row of slots.rows) {
    await ctx.redis.main.del(`ore:ads:live:${row.slot_id}`);
  }
});

describe('ads service', () => {
  it('listAdSlots seeds + returns the catalog', async () => {
    const ctx = buildContext();
    const { listAdSlots } = await import('./ads.js');
    const slots = await listAdSlots(ctx);
    expect(slots.length).toBeGreaterThanOrEqual(4);
    const ids = slots.map((s) => s.slotId);
    expect(ids).toContain('billboard_01');
    expect(ids).toContain('pixel_tile_001');
  });

  it('uploadCreative rejects bad mime', async () => {
    const ctx = buildContext();
    const { uploadCreative } = await import('./ads.js');
    await expect(
      uploadCreative(ctx, userId, {
        mimeType: 'application/octet-stream',
        bytes: Buffer.from([1, 2, 3]),
        filename: 'x',
      }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('uploadCreative rejects empty body', async () => {
    const ctx = buildContext();
    const { uploadCreative } = await import('./ads.js');
    await expect(
      uploadCreative(ctx, userId, {
        mimeType: 'image/png',
        bytes: Buffer.alloc(0),
        filename: 'x',
      }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('uploadCreative rejects > 1 MB', async () => {
    const ctx = buildContext();
    const { uploadCreative } = await import('./ads.js');
    const big = Buffer.alloc(1_048_577, 1);
    await expect(
      uploadCreative(ctx, userId, {
        mimeType: 'image/png',
        bytes: big,
        filename: 'x',
      }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('bookAd writes the ad_bookings + ad_creatives row in one UoW', async () => {
    const ctx = buildContext();
    const { listAdSlots, bookAd } = await import('./ads.js');
    const slots = await listAdSlots(ctx);
    const slot = slots[0]!;
    const termId = slot.terms[0]!.termId;
    const uploadId = uuidv7();
    const out = await bookAd(ctx, userId, {
      slotId: slot.slotId,
      termId,
      uploadId,
      link: 'https://example.com',
      imageKey: `ads/${uploadId}.png`,
      mimeType: 'image/png',
      sizeBytes: 1024,
    });
    expect(out.booking.status).toBe('pending_review');
    expect(out.booking.slotId).toBe(slot.slotId);
    expect(out.creative.mimeType).toBe('image/png');
    expect(out.creative.bookingId).toBe(out.booking.bookingId);
  });

  it('bookAd refuses unknown slot', async () => {
    const ctx = buildContext();
    const { bookAd } = await import('./ads.js');
    const uploadId = uuidv7();
    await expect(
      bookAd(ctx, userId, {
        slotId: 'no-such-slot',
        termId: 'term_7d',
        uploadId,
        link: 'https://example.com',
        imageKey: `ads/${uploadId}.png`,
        mimeType: 'image/png',
        sizeBytes: 1024,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('bookAd refuses unknown term', async () => {
    const ctx = buildContext();
    const { listAdSlots, bookAd } = await import('./ads.js');
    const slots = await listAdSlots(ctx);
    const slot = slots[0]!;
    const uploadId = uuidv7();
    await expect(
      bookAd(ctx, userId, {
        slotId: slot.slotId,
        termId: 'term_99y',
        uploadId,
        link: 'https://example.com',
        imageKey: `ads/${uploadId}.png`,
        mimeType: 'image/png',
        sizeBytes: 1024,
      }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('approveBooking flips status to live + invalidates the cache', async () => {
    const ctx = buildContext();
    const { listAdSlots, bookAd, approveBooking, listLiveAdsForSlot } = await import('./ads.js');
    const slots = await listAdSlots(ctx);
    const slot = slots[0]!;
    const termId = slot.terms[0]!.termId;
    const uploadId = uuidv7();
    const bk = await bookAd(ctx, userId, {
      slotId: slot.slotId,
      termId,
      uploadId,
      link: 'https://example.com',
      imageKey: `ads/${uploadId}.png`,
      mimeType: 'image/png',
      sizeBytes: 1024,
    });
    const approved = await approveBooking(ctx, bk.booking.bookingId);
    expect(approved.status).toBe('live');
    const live = await listLiveAdsForSlot(ctx, slot.slotId);
    expect(live.some((l) => l.bookingId === bk.booking.bookingId)).toBe(true);
  });

  it('rejectBooking flips status to rejected', async () => {
    const ctx = buildContext();
    const { listAdSlots, bookAd, rejectBooking } = await import('./ads.js');
    const slots = await listAdSlots(ctx);
    const slot = slots[0]!;
    const termId = slot.terms[0]!.termId;
    const uploadId = uuidv7();
    const bk = await bookAd(ctx, userId, {
      slotId: slot.slotId,
      termId,
      uploadId,
      link: 'https://example.com',
      imageKey: `ads/${uploadId}.png`,
      mimeType: 'image/png',
      sizeBytes: 1024,
    });
    const rejected = await rejectBooking(ctx, bk.booking.bookingId);
    expect(rejected.status).toBe('rejected');
  });

  it('approve on non-pending booking raises NotFoundError', async () => {
    const ctx = buildContext();
    const { approveBooking } = await import('./ads.js');
    await expect(approveBooking(ctx, uuidv7())).rejects.toBeInstanceOf(NotFoundError);
  });

  it('listMyBookings returns the user-owned bookings newest first', async () => {
    const ctx = buildContext();
    const { listAdSlots, bookAd, listMyBookings } = await import('./ads.js');
    const slots = await listAdSlots(ctx);
    const slot = slots[0]!;
    const termId = slot.terms[0]!.termId;
    const u1 = uuidv7();
    const u2 = uuidv7();
    await bookAd(ctx, userId, {
      slotId: slot.slotId,
      termId,
      uploadId: u1,
      link: 'https://example.com/1',
      imageKey: `ads/${u1}.png`,
      mimeType: 'image/png',
      sizeBytes: 1024,
    });
    await bookAd(ctx, userId, {
      slotId: slot.slotId,
      termId,
      uploadId: u2,
      link: 'https://example.com/2',
      imageKey: `ads/${u2}.png`,
      mimeType: 'image/png',
      sizeBytes: 1024,
    });
    const rows = await listMyBookings(ctx, userId, 50);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0]!.createdAt >= rows[1]!.createdAt).toBe(true);
  });
});
