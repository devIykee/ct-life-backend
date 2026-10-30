/**
 * Ads service tests (real DB + Redis; fake S3 and chain).
 *
 * Covers the paid lifecycle: owner-bound uploads that are decoded and
 * re-encoded, server-priced booking intents, one winner per slot window,
 * no review or live state before a verified payment, owed refunds on
 * reject/cancel, expiry, and live ads carrying a usable image URL.
 */
import { Pool } from 'pg';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import sharp from 'sharp';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';

import { buildContext, _resetContextForTests, type AppContext } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { HeliusClient } from '../shared/solana/helius.js';
import { _setClusterRpcForTests } from './chain-rpc.js';
import type { S3 } from '../shared/s3/client.js';
import type { IntentResult } from './topup.js';
import {
  approveBooking,
  bookAd,
  cancelBooking,
  expireAdBookings,
  getBooking,
  getSlotAvailability,
  listAdSlots,
  listLiveAdsForSlot,
  recordRefund,
  rejectBooking,
  uploadCreative,
} from './ads.js';
import { reconcilePaymentIntent } from './topup.js';

loadDotenv({ path: process.cwd() + '/.env' });
_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({
  connectionString: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL,
});
const SLOT = 'billboard_01';
const TERM_MS = 7 * 24 * 60 * 60 * 1000;

let owner: { id: string; wallet: string };
let other: { id: string; wallet: string };
let png: Buffer;
let stored: Map<string, Buffer>;
let finalized: Map<string, unknown>;

const s3: S3 = {
  async put(key, body) {
    stored.set(key, Buffer.from(body));
    return {};
  },
  async presignGet(key, ttl) {
    return `https://s3.test/${key}?ttl=${ttl}`;
  },
  async presignPut(key) {
    return `https://s3.test/${key}`;
  },
  async remove() {},
  async ensureBucket() {},
};

const helius = {
  async rpc<T>(method: string, params: unknown[]): Promise<T> {
    if (method === 'getTransaction') return (finalized.get(params[0] as string) ?? null) as T;
    if (method === 'getSignaturesForAddress') return [] as T;
    throw new Error(`unexpected rpc ${method}`);
  },
} as unknown as HeliusClient;

// Reconciliation reads the deployment's cluster RPC (chain-rpc.ts), not ctx.helius.
_setClusterRpcForTests(helius);

function ctx(): AppContext {
  return { ...buildContext(), s3, helius };
}

async function addUser(tag: string) {
  const id = uuidv7();
  const wallet = Keypair.generate().publicKey.toBase58();
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [id, wallet]);
  void tag;
  return { id, wallet };
}

/** Put a finalized, exactly matching USDC payment for `intent` on the fake chain. */
async function pay(intent: IntentResult, wallet: string): Promise<void> {
  const signature = uuidv7().replace(/-/g, '').repeat(3).slice(0, 88);
  const mint = new PublicKey(intent.mint!);
  const source = getAssociatedTokenAddressSync(mint, new PublicKey(wallet)).toBase58();
  const destination = getAssociatedTokenAddressSync(
    mint,
    new PublicKey(intent.recipient),
  ).toBase58();
  finalized.set(signature, {
    blockTime: Math.floor(Date.now() / 1000),
    meta: {
      err: null,
      preTokenBalances: [],
      postTokenBalances: [
        {
          accountIndex: 2,
          mint: intent.mint,
          owner: intent.recipient,
          uiTokenAmount: { amount: intent.amount, decimals: 6 },
        },
      ],
    },
    transaction: {
      message: {
        accountKeys: [
          { pubkey: wallet, signer: true },
          { pubkey: intent.reference, signer: false },
          { pubkey: destination, signer: false },
        ],
        instructions: [
          {
            programId: TOKEN_PROGRAM_ID.toBase58(),
            parsed: {
              type: 'transferChecked',
              info: {
                source,
                destination,
                authority: wallet,
                mint: intent.mint,
                tokenAmount: { amount: intent.amount, decimals: 6 },
              },
            },
          },
          { programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', parsed: intent.memo },
        ],
      },
    },
  });
  expect(await reconcilePaymentIntent(ctx(), intent.intentId, signature)).toBe('confirmed');
}

async function upload(userId = owner.id) {
  return uploadCreative(ctx(), userId, { mimeType: 'image/png', bytes: png, filename: 'c' });
}

async function book(userId = owner.id) {
  const up = await upload(userId);
  return bookAd(ctx(), userId, {
    slotId: SLOT,
    termId: 'term_7d',
    uploadId: up.uploadId,
    link: 'https://example.com/ad',
  });
}

beforeAll(async () => {
  owner = await addUser('owner');
  other = await addUser('other');
  // A real PNG with an embedded text chunk (metadata that must be dropped).
  png = await sharp({
    create: { width: 32, height: 16, channels: 3, background: { r: 200, g: 20, b: 20 } },
  })
    .png()
    .withMetadata({ exif: { IFD0: { ImageDescription: 'secret-exif' } } })
    .toBuffer();
  vi.spyOn(Connection.prototype, 'getLatestBlockhash').mockResolvedValue({
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 1,
  });
  await listAdSlots(ctx());
});

afterAll(async () => {
  vi.restoreAllMocks();
  await pool.end();
});

beforeEach(async () => {
  stored = new Map();
  finalized = new Map();
  await pool.query(`DELETE FROM ad_creatives`);
  await pool.query(`DELETE FROM ad_bookings`);
  const c = buildContext();
  const slots = await pool.query<{ slot_id: string }>(`SELECT slot_id FROM ad_slots`);
  for (const row of slots.rows) await c.redis.main.del(`ore:ads:live:${row.slot_id}`);
});

describe('ad uploads', () => {
  it('re-encodes the image without metadata and binds it to the uploader', async () => {
    const up = await upload();
    const bytes = stored.get(up.imageKey)!;
    expect(bytes.subarray(1, 4).toString()).toBe('PNG');
    expect(bytes.includes(Buffer.from('secret-exif'))).toBe(false);
    expect(up).toMatchObject({ creativeId: up.uploadId, mimeType: 'image/png' });
    expect(up.url).toContain(up.imageKey);
    const row = await pool.query(
      `SELECT user_id, size_bytes FROM ad_uploads WHERE upload_id = $1`,
      [up.uploadId],
    );
    expect(row.rows[0]).toEqual({ user_id: owner.id, size_bytes: bytes.length });
  });

  it.each([
    ['a bad mime', 'image/gif', Buffer.from('GIF89a')],
    ['an empty body', 'image/png', Buffer.alloc(0)],
    ['non-image bytes', 'image/png', Buffer.from('definitely not a png')],
    ['more than 1 MiB', 'image/png', Buffer.alloc(1_048_577, 1)],
  ])('rejects %s', async (_label, mimeType, bytes) => {
    await expect(
      uploadCreative(ctx(), owner.id, { mimeType, bytes, filename: 'c' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects a JPEG declared as PNG', async () => {
    const jpeg = await sharp(png).jpeg().toBuffer();
    await expect(
      uploadCreative(ctx(), owner.id, { mimeType: 'image/png', bytes: jpeg, filename: 'c' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('ad bookings', () => {
  it('prices the booking on the server and waits for payment', async () => {
    const out = await book();
    expect(out.intent).toMatchObject({ amount: '20000000', currency: 'USDC', cashCents: 2000 });
    expect(out.booking).toMatchObject({
      status: 'awaiting_payment',
      intentId: out.intent.intentId,
      priceCents: 2000,
      paidAt: null,
    });
    expect(out.creative.imageKey).toMatch(/^ads\//);
    const kind = await pool.query(`SELECT kind FROM payment_intents WHERE intent_id = $1`, [
      out.intent.intentId,
    ]);
    expect(kind.rows[0]).toEqual({ kind: 'ad' });
  });

  it("refuses someone else's upload and a reused upload", async () => {
    const theirs = await upload(other.id);
    await expect(
      bookAd(ctx(), owner.id, {
        slotId: SLOT,
        termId: 'term_7d',
        uploadId: theirs.uploadId,
        link: 'https://example.com',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const mine = await upload();
    const args = {
      slotId: SLOT,
      termId: 'term_7d',
      uploadId: mine.uploadId,
      link: 'https://example.com',
    };
    await bookAd(ctx(), owner.id, args);
    await expect(bookAd(ctx(), owner.id, args)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('refuses unknown slots, terms and non-http links', async () => {
    const up = await upload();
    const base = { slotId: SLOT, termId: 'term_7d', uploadId: up.uploadId, link: 'https://x.y' };
    await expect(bookAd(ctx(), owner.id, { ...base, slotId: 'nope' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(bookAd(ctx(), owner.id, { ...base, termId: 'term_99d' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(
      bookAd(ctx(), owner.id, { ...base, link: 'javascript:alert(1)' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('gives concurrent bookings back-to-back windows, never the same one', async () => {
    const [a, b] = await Promise.all([book(owner.id), book(other.id)]);
    const windows = [a.booking, b.booking]
      .map((x) => [Date.parse(x.startsAt!), Date.parse(x.endsAt!)] as const)
      .sort((x, y) => x[0] - y[0]);
    expect(windows[0]![1] - windows[0]![0]).toBe(TERM_MS);
    expect(windows[1]![0]).toBe(windows[0]![1]);
    const avail = await getSlotAvailability(ctx(), SLOT, 'term_7d');
    expect(avail.available).toBe(false);
    expect(avail.nextStartAt).toBe(new Date(windows[1]![1]).toISOString());
  });

  it('cannot go live before a verified payment, then goes live with an image URL', async () => {
    const out = await book();
    await expect(approveBooking(ctx(), out.booking.bookingId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await pay(out.intent, owner.wallet);
    expect((await getBooking(ctx(), owner.id, out.booking.bookingId)).status).toBe(
      'pending_review',
    );
    await approveBooking(ctx(), out.booking.bookingId);
    const live = await listLiveAdsForSlot(ctx(), SLOT);
    expect(live).toEqual([
      expect.objectContaining({
        bookingId: out.booking.bookingId,
        imageUrl: `https://s3.test/${out.creative.imageKey}?ttl=3600`,
        sponsored: true,
      }),
    ]);
    await expect(getBooking(ctx(), other.id, out.booking.bookingId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('records an owed refund on rejection and the refund receipt', async () => {
    const out = await book();
    await pay(out.intent, owner.wallet);
    const rejected = await rejectBooking(ctx(), out.booking.bookingId);
    expect(rejected.refund).toEqual({ status: 'due', cents: 2000, signature: null });
    const sig = 'r'.repeat(88);
    await recordRefund(ctx(), out.booking.bookingId, sig);
    await recordRefund(ctx(), out.booking.bookingId, sig);
    expect((await getBooking(ctx(), owner.id, out.booking.bookingId)).refund).toEqual({
      status: 'refunded',
      cents: 2000,
      signature: sig,
    });
  });

  it('frees the window on an unpaid cancel and owes a payment that lands afterwards', async () => {
    const out = await book();
    const cancelled = await cancelBooking(ctx(), owner.id, out.booking.bookingId);
    expect(cancelled).toMatchObject({ status: 'cancelled', refund: null });
    expect((await getSlotAvailability(ctx(), SLOT)).available).toBe(true);
    await pay(out.intent, owner.wallet);
    expect((await getBooking(ctx(), owner.id, out.booking.bookingId)).refund).toEqual({
      status: 'due',
      cents: 2000,
      signature: null,
    });
  });

  it('expires unpaid holds and finished terms', async () => {
    const unpaid = await book();
    await pool.query(`UPDATE payment_intents SET status = 'expired' WHERE intent_id = $1`, [
      unpaid.intent.intentId,
    ]);
    const paid = await book(other.id);
    await pay(paid.intent, other.wallet);
    await approveBooking(ctx(), paid.booking.bookingId);
    await pool.query(
      `UPDATE ad_bookings SET starts_at = now() - interval '8 days', ends_at = now() - interval '1 day'
       WHERE booking_id = $1`,
      [paid.booking.bookingId],
    );
    expect(await expireAdBookings(ctx())).toBe(2);
    expect((await getBooking(ctx(), owner.id, unpaid.booking.bookingId)).status).toBe('expired');
    expect((await getBooking(ctx(), other.id, paid.booking.bookingId)).status).toBe('expired');
    expect(await listLiveAdsForSlot(ctx(), SLOT)).toEqual([]);
  });
});
