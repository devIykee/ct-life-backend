/**
 * Push service.
 *
 *   POST /v1/push/register — register a device (apns or fcm token);
 *                            upserts push_devices.
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
  await runInTransaction(async (client) => {
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
