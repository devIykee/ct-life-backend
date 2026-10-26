/**
 * DELETE /v1/me: confirmation required, personal data erased or overwritten,
 * financial rows kept under the anonymised id, sessions dead at once, files
 * queued then erased by the purge, and the same wallet can start over.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { Keypair } from '@solana/web3.js';
import { buildServer } from './main.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { createDb } from '../shared/db/pool.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { buildContext } from '../application/context.js';
import { purgeStorage } from '../application/account-deletion.js';

loadDotenv({ path: process.cwd() + '/.env' });

let app: Awaited<ReturnType<typeof buildServer>>['app'];
let stop: () => Promise<void>;
const db = createDb();

beforeAll(async () => {
  process.env.APP_ENV = process.env.APP_ENV ?? 'local';
  process.env.NODE_ENV = process.env.NODE_ENV ?? 'development';
  process.env.LOG_LEVEL = 'warn';
  process.env.ENABLE_DEV_AUTH = 'true';
  _resetConfigForTests();
  const handle = await buildServer();
  app = handle.app;
  await app.ready();
  stop = handle.stop;
}, 30_000);
afterAll(async () => {
  await stop();
}, 30_000);

interface U {
  sub: string;
  wallet: string;
  accessToken: string;
  refreshToken: string;
}
async function devAuth(wallet = Keypair.generate().publicKey.toBase58()): Promise<U> {
  const r = await app.inject({
    method: 'POST',
    url: '/v1/auth/dev',
    headers: { 'idempotency-key': `del-${uuidv7()}` },
    payload: { wallet },
  });
  expect(r.statusCode, r.body).toBe(200);
  const b = r.json() as { id: string; accessToken: string; refreshToken: string };
  return { sub: b.id, wallet, accessToken: b.accessToken, refreshToken: b.refreshToken };
}
const del = (u: U, payload?: unknown) =>
  app.inject({
    method: 'DELETE',
    url: '/v1/me',
    headers: { authorization: `Bearer ${u.accessToken}`, 'idempotency-key': uuidv7() },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
const q = <T extends Record<string, unknown>>(sql: string, p: unknown[]) =>
  db.withConnection(async (c) => (await c.query<T>(sql, p)).rows);

async function seed(u: U): Promise<{ other: U; likenessKey: string; adKey: string }> {
  const other = await devAuth();
  const likenessKey = `${uuidv7()}.jpg`;
  const adKey = `ads/${uuidv7()}.png`;
  await db.withConnection(async (c) => {
    await c.query(
      `INSERT INTO characters (id, user_id, alias, look, tribe_id, trait_ids, dream_id, home_id)
       VALUES ($1, $2, $3, '{}', 'degens', '{}', 'x', 'h')`,
      [uuidv7(), u.sub, `del${Date.now().toString(36)}`],
    );
    await c.query(
      `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
       VALUES ($1::uuid, 500, 'cash', 'airdrop', 'airdrop_claim', $1::text, $2)`,
      [u.sub, `del:${uuidv7()}`],
    );
    await c.query(
      `INSERT INTO follows (follower_user_id, followee_user_id) VALUES ($1, $2), ($2, $1)`,
      [u.sub, other.sub],
    );
    await c.query(`INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2)`, [
      u.sub,
      other.sub,
    ]);
    await c.query(
      `INSERT INTO dm_messages (message_id, from_user_id, to_user_id, text) VALUES ($1,$2,$3,'secret'), ($4,$3,$2,'reply')`,
      [uuidv7(), u.sub, other.sub, uuidv7()],
    );
    await c.query(`INSERT INTO feed_posts (post_id, user_id, text) VALUES ($1, $2, 'my post')`, [
      uuidv7(),
      u.sub,
    ]);
    await c.query(
      `INSERT INTO push_devices (device_id, user_id, platform, fcm_token) VALUES ($1, $2, 'android', $3)`,
      [uuidv7(), u.sub, `tok-${uuidv7()}`],
    );
    await c.query(
      `INSERT INTO likeness_uploads (id, user_id, object_key, content_sha256, content_type, size_bytes, verified_at, expires_at)
       VALUES ($1, $2, $3, repeat('a', 64), 'image/jpeg', 10, now(), now() + interval '1 day')`,
      [uuidv7(), u.sub, likenessKey],
    );
    await c.query(
      `INSERT INTO ad_uploads (upload_id, user_id, image_key, mime_type, size_bytes, sha256)
       VALUES ($1, $2, $3, 'image/png', 10, repeat('b', 64))`,
      [uuidv7(), u.sub, adKey],
    );
  });
  return { other, likenessKey, adKey };
}

describe('DELETE /v1/me', () => {
  it('needs auth and an explicit confirmation; a wrong body deletes nothing', async () => {
    const u = await devAuth();
    const anon = await app.inject({
      method: 'DELETE',
      url: '/v1/me',
      payload: { confirm: 'DELETE' },
    });
    expect(anon.statusCode).toBe(401);
    for (const body of [undefined, {}, { confirm: 'yes' }, { confirm: 'delete' }]) {
      const r = await del(u, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
      expect((r.json() as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
    }
    const rows = await q<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM users WHERE id = $1',
      [u.sub],
    );
    expect(rows[0]!.deleted_at).toBeNull();
    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${u.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
  });

  it('erases personal data, keeps the ledger under the anonymised id, kills sessions', async () => {
    const u = await devAuth();
    const { other } = await seed(u);

    const r = await del(u, { confirm: 'DELETE' });
    expect(r.statusCode, r.body).toBe(204);

    const user = await q<{
      wallet: string;
      sgt_mint: string | null;
      skr_name: string | null;
      deleted_at: Date;
    }>('SELECT wallet, sgt_mint, skr_name, deleted_at FROM users WHERE id = $1', [u.sub]);
    expect(user[0]!.wallet).toBe(`deleted:${u.sub}`);
    expect(user[0]!.sgt_mint).toBeNull();
    expect(user[0]!.deleted_at).not.toBeNull();

    const count = async (sql: string, p: unknown[] = [u.sub]) =>
      Number((await q<{ n: string }>(sql, p))[0]!.n);
    expect(await count('SELECT count(*) n FROM characters WHERE user_id = $1')).toBe(0);
    expect(
      await count(
        'SELECT count(*) n FROM follows WHERE follower_user_id = $1 OR followee_user_id = $1',
      ),
    ).toBe(0);
    expect(
      await count(
        'SELECT count(*) n FROM blocks WHERE blocker_user_id = $1 OR blocked_user_id = $1',
      ),
    ).toBe(0);
    expect(await count('SELECT count(*) n FROM push_devices WHERE user_id = $1')).toBe(0);
    expect(await count('SELECT count(*) n FROM likeness_uploads WHERE user_id = $1')).toBe(0);
    expect(await count('SELECT count(*) n FROM ad_uploads WHERE user_id = $1')).toBe(0);
    // Money stays.
    expect(await count('SELECT count(*) n FROM ledger_entries WHERE user_id = $1')).toBe(1);
    // What the user wrote is overwritten; what others wrote to them is not touched.
    const dms = await q<{ text: string; from_user_id: string }>(
      'SELECT text, from_user_id FROM dm_messages WHERE from_user_id = $1 OR to_user_id = $1',
      [u.sub],
    );
    expect(dms.find((d) => d.from_user_id === u.sub)!.text).toBe('[deleted]');
    expect(dms.find((d) => d.from_user_id === other.sub)!.text).toBe('reply');
    const posts = await q<{ text: string }>('SELECT text FROM feed_posts WHERE user_id = $1', [
      u.sub,
    ]);
    expect(posts[0]!.text).toBe('[deleted]');

    // Sessions: the live access token and the refresh token both stop working.
    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${u.accessToken}` },
    });
    expect(me.statusCode).toBe(401);
    const refresh = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { 'idempotency-key': uuidv7() },
      payload: { refreshToken: u.refreshToken },
    });
    expect(refresh.statusCode).toBe(401);

    // Idempotent: asking again changes nothing (the token is dead, so 401).
    expect((await del(u, { confirm: 'DELETE' })).statusCode).toBe(401);
  });

  it('queues files, and the purge erases them (and retries failures)', async () => {
    const u = await devAuth();
    const { likenessKey, adKey } = await seed(u);
    await del(u, { confirm: 'DELETE' });
    const queued = await q<{ store: string; object_key: string }>(
      'SELECT store, object_key FROM storage_cleanup WHERE object_key = ANY($1) AND done_at IS NULL',
      [[likenessKey, adKey]],
    );
    expect(queued.map((r) => `${r.store}:${r.object_key}`).sort()).toEqual(
      [`ads:${adKey}`, `likeness:${likenessKey}`].sort(),
    );

    const ctx = buildContext();
    const gone: string[] = [];
    // The ads store is down: its row stays queued and records the failure.
    await purgeStorage(ctx, {
      likeness: async (k) => void gone.push(k),
      ads: async () => {
        throw new Error('s3 down');
      },
    });
    expect(gone).toContain(likenessKey);
    let rows = await q<{ store: string; done_at: Date | null; attempts: number }>(
      'SELECT store, done_at, attempts FROM storage_cleanup WHERE object_key = ANY($1)',
      [[likenessKey, adKey]],
    );
    expect(rows.find((r) => r.store === 'likeness')!.done_at).not.toBeNull();
    const ad = rows.find((r) => r.store === 'ads')!;
    expect(ad.done_at).toBeNull();
    expect(ad.attempts).toBe(1);
    // Next run succeeds.
    await purgeStorage(ctx, { ads: async (k) => void gone.push(k) });
    expect(gone).toContain(adKey);
    rows = await q('SELECT store, done_at, attempts FROM storage_cleanup WHERE object_key = $1', [
      adKey,
    ]);
    expect(rows[0]!.done_at).not.toBeNull();
  });

  it('the same wallet can sign up again as a brand new account', async () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const first = await devAuth(wallet);
    expect((await del(first, { confirm: 'DELETE' })).statusCode).toBe(204);
    const second = await devAuth(wallet);
    expect(second.sub).not.toBe(first.sub);
    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${second.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
  });
});
