/**
 * Push service.
 *
 *   POST /v1/push/register — register a device (apns or fcm token);
 *                            upserts push_devices.
 *
 *   DELETE /v1/push/register — unregister a token for the caller only.
 *
 * One account per token: a token is bound to exactly one user (unique index, migration
 * 085). Registering a token that another user holds moves it to the caller in the same
 * transaction, so the previous account can never receive pushes on this device.
 *
 * Per spec section 4 (POST /v1/push/register {token}, 204).
 * The M4 slice accepts { platform, apnsToken?, fcmToken? } and
 * upserts on (user_id, platform, apns_token/fcm_token).
 *
 * Real push delivery (FCM/APNS HTTP) ships in Phase 5. The
 * M4 scope is just the device row.
 */
import { runInTransaction } from '../shared/db/uow.js';
import { ValidationFailedError } from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { AppContext } from './context.js';

export type PushPlatform = 'ios' | 'android' | 'web';

export interface RegisterDeviceArgs {
  readonly platform: PushPlatform;
  readonly apnsToken: string | null;
  readonly fcmToken: string | null;
  readonly enabled?: boolean;
}

export interface PushDeviceRow {
  readonly deviceId: string;
  readonly userId: string;
  readonly platform: PushPlatform;
  readonly apnsToken: string | null;
  readonly fcmToken: string | null;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Register or update a device. */
export async function registerDevice(
  ctx: AppContext,
  userId: string,
  args: RegisterDeviceArgs,
): Promise<PushDeviceRow> {
  if (args.platform === 'ios' && !args.apnsToken) {
    throw new ValidationFailedError({ reason: 'ios requires apnsToken' });
  }
  if ((args.platform === 'android' || args.platform === 'web') && !args.fcmToken) {
    throw new ValidationFailedError({ reason: `${args.platform} requires fcmToken` });
  }
  const deviceId = uuidv7();
  const enabled = args.enabled ?? true;
  const write = (): Promise<void> =>
    runInTransaction(async (client) => {
      // Move the token: no other account keeps it.
      await client.query(
        `DELETE FROM push_devices
          WHERE user_id <> $1
            AND (($2::text IS NOT NULL AND fcm_token = $2) OR ($3::text IS NOT NULL AND apns_token = $3))`,
        [userId, args.fcmToken, args.apnsToken],
      );
      // Upsert: match on (user_id, platform, token).
      const sel = await client.query<{ device_id: string }>(
        `SELECT device_id FROM push_devices
         WHERE user_id = $1 AND platform = $2
           AND ($3::text IS NULL OR apns_token = $3)
           AND ($4::text IS NULL OR fcm_token = $4)
         LIMIT 1`,
        [userId, args.platform, args.apnsToken, args.fcmToken],
      );
      if (sel.rows[0]) {
        await client.query(
          `UPDATE push_devices SET enabled = $1, updated_at = now()
           WHERE device_id = $2`,
          [enabled, sel.rows[0].device_id],
        );
      } else {
        try {
          await client.query(
            `INSERT INTO push_devices
               (device_id, user_id, platform, apns_token, fcm_token, enabled)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [deviceId, userId, args.platform, args.apnsToken, args.fcmToken, enabled],
          );
        } catch (e) {
          // 23501 CHECK (platform/apns_token/fcm_token).
          if ((e as { code?: string }).code === '23514') {
            throw new ValidationFailedError({ reason: 'platform/token mismatch' });
          }
          throw e;
        }
      }
    });
  // Two accounts registering the same new token at once: the unique index stops the second;
  // try again and it moves the token instead.
  for (let attempt = 0; ; attempt++) {
    try {
      await write();
      break;
    } catch (e) {
      if ((e as { code?: string }).code !== '23505' || attempt >= 2) throw e;
    }
  }
  // Re-read so we return the canonical row.
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<{
      device_id: string;
      user_id: string;
      platform: PushPlatform;
      apns_token: string | null;
      fcm_token: string | null;
      enabled: boolean;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT device_id, user_id, platform, apns_token, fcm_token, enabled, created_at, updated_at
       FROM push_devices
       WHERE user_id = $1 AND platform = $2
         AND ($3::text IS NULL OR apns_token = $3)
         AND ($4::text IS NULL OR fcm_token = $4)
       LIMIT 1`,
      [userId, args.platform, args.apnsToken, args.fcmToken],
    );
  });
  const row = r.rows[0];
  if (!row) throw new Error('device upsert failed');
  return {
    deviceId: row.device_id,
    userId: row.user_id,
    platform: row.platform,
    apnsToken: row.apns_token,
    fcmToken: row.fcm_token,
    enabled: row.enabled,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Remove a push token for the caller. A token that belongs to someone else, or to nobody,
 * is left alone and the call looks the same.
 * @param ctx - The application context.
 * @param userId - The caller.
 * @param tokens - Exactly one of `fcmToken` or `apnsToken`; only the caller's own rows are removed.
 * @returns How many of the caller's device rows were removed.
 */
export async function unregisterDevice(
  ctx: AppContext,
  userId: string,
  tokens: { fcmToken?: string | undefined; apnsToken?: string | undefined },
): Promise<number> {
  const fcm = tokens.fcmToken ?? null;
  const apns = tokens.apnsToken ?? null;
  if (fcm === null && apns === null) return 0;
  const r = await ctx.db.withConnection((c) =>
    c.query(`DELETE FROM push_devices WHERE user_id = $1 AND (fcm_token = $2 OR apns_token = $3)`, [
      userId,
      fcm,
      apns,
    ]),
  );
  return r.rowCount ?? 0;
}
