/** Durable write receipts shared by owner approval, cancellation and source deletion. */
import type { PoolClient } from 'pg';
import { ValidationFailedError } from '../domain/errors.js';
export interface LikenessActionReceipt {
  key: string;
  hash: string;
}
export async function recordLikenessAction(
  c: PoolClient,
  userId: string,
  receipt: LikenessActionReceipt | undefined,
  now: Date,
): Promise<boolean> {
  if (!receipt) return false; // Internal retention/consent processing has no HTTP request.
  const previous = await c.query<{ request_hash: string }>(
    'SELECT request_hash FROM likeness_action_receipts WHERE user_id=$1 AND request_key=$2 FOR UPDATE',
    [userId, receipt.key],
  );
  if (previous.rows[0]) {
    if (previous.rows[0].request_hash !== receipt.hash)
      throw new ValidationFailedError({ reason: 'idempotency_body_mismatch' });
    return true;
  }
  // Concurrent ON CONFLICT under SERIALIZABLE is retried by the unit of work.
  const written = await c.query<{ request_hash: string }>(
    `INSERT INTO likeness_action_receipts(user_id,request_key,request_hash,created_at)
    VALUES($1,$2,$3,$4) ON CONFLICT(user_id,request_key) DO UPDATE
    SET request_hash=likeness_action_receipts.request_hash RETURNING request_hash`,
    [userId, receipt.key, receipt.hash, now],
  );
  if (written.rows[0]?.request_hash !== receipt.hash)
    throw new ValidationFailedError({ reason: 'idempotency_body_mismatch' });
  return false;
}
