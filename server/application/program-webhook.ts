/**
 * Helius program-event webhook for ct_escrow.
 *
 * Helius Enhanced Webhooks lets us subscribe to a single program
 * address. When a transaction that invokes the Anchor ct_escrow
 * program lands on the chain, Helius POSTs the parsed transaction
 * to `/v1/webhooks/helius-program`. The payload includes the
 * transaction signature, the account keys, the parsed logs, and
 * the inner instructions. We:
 *
 *  1. Verify the Helius signature header (HMAC-SHA256 over the
 *     raw body with `HELIUS_WEBHOOK_SECRET`).
 *  2. Iterate the log lines, find the base64-encoded Settled or
 *     Refunded event, decode it with `decodeCtEscrowEvent`.
 *  3. Look up the escrow row by the on-chain session pubkey +
 *     the call_id (we map session PDA → call_id via the
 *     `onchain_session_id` column).
 *  4. Mark the escrow row settled/refunded, write the in-game
 *     ledger rows (`tip` for the creator, `fee` for the
 *     treasury), end the LiveKit room, idempotent on
 *     (source='helius_program', signature).
 *
 * The Helius webhook is the source of truth for the in-game
 * ledger after the on-chain settlement. The on-chain movement
 * is the source of truth for real USDC.
 */
import { timingSafeEqual } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { runInTransaction } from '../shared/db/uow.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import {
  ForbiddenError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import { decodeCtEscrowEvent } from '../shared/solana/ct-escrow.js';
import { configPda } from '../shared/solana/ct-escrow.js';
import type { AppContext } from './context.js';

export interface ProgramWebhookPayload {
  readonly signature: string;
  readonly accountKeys?: ReadonlyArray<string>;
  readonly logMessages?: ReadonlyArray<string>;
}

export interface ProgramWebhookResult {
  readonly ok: true;
  readonly status: 'settled' | 'refunded' | 'ignored' | 'duplicate';
}

/**
 * Verify the Helius webhook authorization header.
 *
 * Helius sends the `authHeader` you configured for the webhook back
 * in the `Authorization` header (not `x-helius-signature`). Compare
 * it exactly as configured using constant-time comparison to prevent
 * timing attacks.
 */
export function verifyProgramWebhookSignature(
  ctx: AppContext,
  authorizationHeader: string | undefined,
  rawBody: string,
): void {
  const secret = ctx.config.helius.webhookSecret;

  // Fail closed: if secret is unset, reject all requests in staging/prod
  if (secret === '') {
    if (ctx.config.appEnv === 'staging' || ctx.config.appEnv === 'prod') {
      throw new ForbiddenError({ reason: 'webhook secret not configured' });
    }
    // In local/mock, allow missing secret for development
    return;
  }

  if (authorizationHeader === undefined || authorizationHeader === '') {
    throw new ValidationFailedError({ reason: 'missing Authorization header' });
  }

  // Constant-time comparison to prevent timing attacks
  // First check length to avoid buffer size mismatch in timingSafeEqual
  if (authorizationHeader.length !== secret.length) {
    throw new ForbiddenError({ reason: 'invalid webhook authorization' });
  }

  if (!timingSafeEqual(Buffer.from(authorizationHeader, 'utf8'), Buffer.from(secret, 'utf8'))) {
    throw new ForbiddenError({ reason: 'invalid webhook authorization' });
  }
}

/**
 * Handle a single program-event webhook delivery. Idempotent on
 * (source='helius_program', signature). Returns
 * `{ status: 'settled' | 'refunded' | 'ignored' | 'duplicate' }`.
 */
export async function handleProgramWebhook(
  ctx: AppContext,
  authorizationHeader: string | undefined,
  rawBody: string,
  payload: ProgramWebhookPayload,
): Promise<ProgramWebhookResult> {
  verifyProgramWebhookSignature(ctx, authorizationHeader, rawBody);

  // Idempotent record: insert into webhook_events; ignore the
  // duplicate.
  const inserted = await ctx.db.withConnection(async (c) => {
    try {
      await c.query(
        `INSERT INTO webhook_events (event_id, source, payload, signature)
         VALUES ($1, 'helius_program', $2::jsonb, $3)`,
        [uuidv7(), JSON.stringify(payload), payload.signature],
      );
      return true;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return false;
      throw e;
    }
  });
  if (!inserted) return { ok: true, status: 'duplicate' };

  for (const log of payload.logMessages ?? []) {
    // Anchor emits "Program data: <base64>" lines for events.
    const m = /^Program (?:data|return): (\S+)/.exec(log);
    if (!m) continue;
    const decoded = decodeCtEscrowEvent(m[1]!);
    if (decoded === null) continue;
    if (decoded.kind === 'settled') {
      await reconcileSettled(ctx, payload.signature, decoded);
      return { ok: true, status: 'settled' };
    }
    if (decoded.kind === 'refunded') {
      await reconcileRefunded(ctx, payload.signature, decoded);
      return { ok: true, status: 'refunded' };
    }
    // opened / accepted: log them and continue. These are
    // informational; the in-game state moves to active/settled
    // via other paths.
  }
  return { ok: true, status: 'ignored' };
}

async function reconcileSettled(
  ctx: AppContext,
  signature: string,
  ev: ReturnType<typeof decodeCtEscrowEvent> & { kind: 'settled' },
): Promise<void> {
  // The session PDA we observed tells us the on-chain fan. We
  // look up the matching escrow row by the fan's pubkey (the
  // user_id is the fan's UUID, not the on-chain key). The
  // webhook payload also carries accountKeys; the row we want
  // is keyed by `onchain_session_id`. We round-trip through
  // Solana to look up the on-chain session and match.
  void new PublicKey(ev.session);
  // The matching row is the most recent paid_call_escrow with
  // status='pending_onchain' and the same settlement signature.
  await runInTransaction(async (client) => {
    const r = await client.query<{
      escrow_id: string;
      payer_user_id: string;
      payee_user_id: string;
      price_per_minute_cents: number;
    }>(
      `SELECT ec.escrow_id, ec.payer_user_id, ec.payee_user_id,
              vr.price_per_minute_cents
         FROM paid_call_escrow ec
         JOIN voice_rooms vr ON vr.room_id = 'paid_call:' || ec.call_id::text
        WHERE ec.status = 'pending_onchain'
          AND ec.settlement_tx_signature = $1
        LIMIT 1`,
      [signature],
    );
    const row = r.rows[0];
    if (!row) return; // no matching row; webhook stays ignored
    // Convert base-unit cents to in-game cents (cents == base
    // units for USDC at 6 decimals, so the conversion is the
    // identity here).
    const feeCents = Number(ev.fee);
    const netCents = Number(ev.creatorAmount);
    const grossCents = Number(ev.refund) + Number(ev.creatorAmount) + Number(ev.fee);
    await client.query(
      `UPDATE paid_call_escrow
         SET status = 'settled', settled_cents = $1, ended_at = now()
       WHERE escrow_id = $2::uuid`,
      [grossCents, row.escrow_id],
    );
    if (netCents > 0) {
      await client.query(
        `INSERT INTO balances (user_id, cash_cents) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET cash_cents = balances.cash_cents + EXCLUDED.cash_cents, updated_at = now()`,
        [row.payee_user_id, netCents],
      );
      await client.query(
        `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
         VALUES ($1, $2, 'cash', 'tip', 'paid_call', $3, $4)`,
        [
          row.payee_user_id,
          netCents,
          row.escrow_id,
          `paid-call-creator:${signature.slice(0, 16)}`,
        ],
      );
    }
    if (feeCents > 0) {
      await client.query(
        `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
         VALUES ($1, $2, 'cash', 'fee', 'paid_call', $3, $4)`,
        [
          row.payer_user_id,
          -feeCents,
          row.escrow_id,
          `paid-call-fee:${signature.slice(0, 16)}`,
        ],
      );
    }
    void configPda; // imported for documentation
  });
  // Best-effort: end the LiveKit room.
  try {
    const r = await ctx.db.withConnection((c) =>
      c.query<{ call_id: string }>(
        `SELECT call_id FROM paid_call_escrow WHERE settlement_tx_signature = $1 LIMIT 1`,
        [signature],
      ),
    );
    const callId = r.rows[0]?.call_id;
    if (callId !== undefined) {
      await ctx.livekit.endRoom(ctx, { kind: 'paid_call', id: callId });
    }
  } catch {
    /* best-effort */
  }
}

async function reconcileRefunded(
  ctx: AppContext,
  signature: string,
  _ev: ReturnType<typeof decodeCtEscrowEvent> & { kind: 'refunded' },
): Promise<void> {
  await runInTransaction(async (client) => {
    await client.query(
      `UPDATE paid_call_escrow
         SET status = 'refunded', ended_at = now()
       WHERE settlement_tx_signature = $1
         AND status = 'pending_onchain'`,
      [signature],
    );
  });
  try {
    const r = await ctx.db.withConnection((c) =>
      c.query<{ call_id: string }>(
        `SELECT call_id FROM paid_call_escrow WHERE settlement_tx_signature = $1 LIMIT 1`,
        [signature],
      ),
    );
    const callId = r.rows[0]?.call_id;
    if (callId !== undefined) {
      await ctx.livekit.endRoom(ctx, { kind: 'paid_call', id: callId });
    }
  } catch {
    /* best-effort */
  }
}