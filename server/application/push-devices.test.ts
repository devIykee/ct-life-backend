/**
 * One account per push token: re-registering moves it, the unique index backs that up,
 * and unregistering only ever touches the caller's own rows.
 */
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { registerDevice, unregisterDevice } from './push.js';

loadDotenv({ path: process.cwd() + '/.env' });
_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ctx = buildContext();

async function newUser(): Promise<string> {
  const id = uuidv7();
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [id, `pd-${id}`]);
  return id;
}
const reg = (u: string, fcmToken: string) =>
  registerDevice(ctx, u, { platform: 'android', apnsToken: null, fcmToken });
async function owners(token: string): Promise<string[]> {
  const r = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM push_devices WHERE fcm_token = $1`,
    [token],
  );
  return r.rows.map((x) => x.user_id);
}

afterAll(async () => {
  await pool.end();
});

describe('one account per token', () => {
  it('registering a token under user B moves it off user A', async () => {
    const a = await newUser();
    const b = await newUser();
    const token = `tok-${uuidv7()}`;
    await reg(a, token);
    expect(await owners(token)).toEqual([a]);
    await reg(b, token);
    expect(await owners(token)).toEqual([b]);
    // A keeps no device row, so nothing can be sent to A on this phone.
    const left = await pool.query(`SELECT 1 FROM push_devices WHERE user_id = $1`, [a]);
    expect(left.rows).toHaveLength(0);
    // Moving it back works the same way, and re-registering under the same user is a no-op.
    await reg(a, token);
    await reg(a, token);
    expect(await owners(token)).toEqual([a]);
  });

  it("another user's other devices are untouched by the move", async () => {
    const a = await newUser();
    const b = await newUser();
    const t1 = `tok-${uuidv7()}`;
    const t2 = `tok-${uuidv7()}`;
    await reg(a, t1);
    await reg(a, t2);
    await reg(b, t1);
    expect(await owners(t1)).toEqual([b]);
    expect(await owners(t2)).toEqual([a]);
  });

  it('the database refuses the same token under two users', async () => {
    const a = await newUser();
    const b = await newUser();
    const token = `tok-${uuidv7()}`;
    await reg(a, token);
    await expect(
      pool.query(
        `INSERT INTO push_devices (device_id, user_id, platform, fcm_token) VALUES ($1, $2, 'android', $3)`,
        [uuidv7(), b, token],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('concurrent registrations of one token by two users leave exactly one owner', async () => {
    const a = await newUser();
    const b = await newUser();
    const token = `tok-${uuidv7()}`;
    await Promise.all([reg(a, token), reg(b, token)]);
    expect(await owners(token)).toHaveLength(1);
  });
});

describe('unregister', () => {
  it('removes the token for its owner', async () => {
    const a = await newUser();
    const token = `tok-${uuidv7()}`;
    await reg(a, token);
    expect(await unregisterDevice(ctx, a, { fcmToken: token })).toBe(1);
    expect(await owners(token)).toEqual([]);
    expect(await unregisterDevice(ctx, a, { fcmToken: token })).toBe(0); // idempotent
  });

  it("cannot remove someone else's token by guessing it (no IDOR)", async () => {
    const a = await newUser();
    const b = await newUser();
    const token = `tok-${uuidv7()}`;
    await reg(b, token);
    expect(await unregisterDevice(ctx, a, { fcmToken: token })).toBe(0);
    expect(await owners(token)).toEqual([b]);
  });

  it('removes an APNs token for its owner only', async () => {
    const a = await newUser();
    const b = await newUser();
    const apnsToken = `apns-${uuidv7()}`;
    await registerDevice(ctx, a, { platform: 'ios', apnsToken, fcmToken: null });
    const count = async (): Promise<number> =>
      (await pool.query(`SELECT 1 FROM push_devices WHERE apns_token = $1`, [apnsToken]))
        .rowCount ?? 0;
    expect(await unregisterDevice(ctx, b, { apnsToken })).toBe(0);
    expect(await count()).toBe(1);
    expect(await unregisterDevice(ctx, a, { apnsToken })).toBe(1);
    expect(await count()).toBe(0);
    expect(await unregisterDevice(ctx, a, { apnsToken })).toBe(0);
  });
});
