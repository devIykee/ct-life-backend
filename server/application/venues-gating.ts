/**
 * Dubai Marina + Cabal Lounge gating (M7 #7).
 *
 * Endpoints:
 *
 *   POST /v1/homes/{id}/marina/visit     — gated by net_worth
 *                                          (>= MARINA_GATE_CENTS).
 *   POST /v1/cabal/invites               — host creates a Cabal
 *                                          invite (single-use), open
 *                                          or for one guest.
 *   POST /v1/cabal/invites/{id}/accept   — guest redeems; sets
 *                                          guest_user_id + used_at.
 *   POST /v1/cabal/invites/{id}/revoke   — host withdraws a pending
 *                                          invite (unlock A3).
 *   GET  /v1/cabal/invites?hostId=&used= — list invites (host
 *                                          or guest filter).
 *
 * Marina gate:
 *   The Marina is a high-rent home that requires the visitor
 *   to have a net worth >= 10M cents ($100,000). This is the
 *   M4 #52 home kind + a server-side check. The application
 *   computes net_worth = cash_cents - debt_cents (the M2
 *   formula). The gate is enforced inside the transaction.
 *
 * Cabal invite:
 *   The Cabal is invite-only. A host needs net worth >= the Marina
 *   gate and may have CABAL_INVITES_PER_HOST pending invites at once.
 *   An invite is either open (anyone but the host may accept it) or
 *   targeted (`guestUserId` set at creation; only that player may
 *   accept, never a blocked pair). It is single-use (used_at), expires
 *   after CABAL_INVITE_TTL_DAYS, and the host can revoke it while it
 *   is pending (revoked_at). `status` is derived: revoked > accepted
 *   > expired > pending. The bearer `code` is only ever shown to the
 *   host.
 */
import { runInTransaction } from '../shared/db/uow.js';
import {
  BlockedError,
  ConflictError,
  ForbiddenError,
  NetWorthTooLowError,
  NotFoundError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { randomBytes } from 'node:crypto';
import { careerAreasAt } from './ladders.js';
import { activeJail, JAIL_VENUE_ID } from './heat.js';
import type { AppContext } from './context.js';
import { publishToUser } from './realtime-bus.js';

export const MARINA_GATE_CENTS = 10_000_000; // $100,000
const CABAL_INVITE_TTL_DAYS = 7;
/** Invites a host may have pending at once. */
export const CABAL_INVITES_PER_HOST = 3;
const CODE_BYTES = 24; // 32-char base64url

export type CabalInviteStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export interface CabalInviteRow {
  readonly inviteId: string;
  readonly hostUserId: string;
  readonly guestUserId: string | null;
  /** The bearer code; only present when the caller is the host. */
  readonly code?: string;
  readonly status: CabalInviteStatus;
  readonly usedAt: string | null;
  readonly revokedAt: string | null;
  readonly expiresAt: string;
  readonly createdAt: string;
}

interface CabalInviteDbRow {
  invite_id: string;
  host_user_id: string;
  guest_user_id: string | null;
  code: string;
  used_at: Date | null;
  revoked_at: Date | null;
  expires_at: Date;
  created_at: Date;
}

const INVITE_COLS = `invite_id, host_user_id, guest_user_id, code, used_at, revoked_at,
                     expires_at, created_at`;

interface BalanceRow {
  cash_cents: string;
  debt_cents: string;
}

/**
 * Marina visit. Returns the visit token (the home_id for now;
 * the M4 #52 home room is the entry point). Refuses with
 * ForbiddenError if the caller's net worth is below the gate.
 */
export async function marinaVisit(
  _ctx: AppContext,
  userId: string,
  homeId: string,
): Promise<{ homeId: string; userId: string; admitted: true }> {
  if (homeId !== 'marina_villa') {
    // Only the Marina home kind is gated. Other homes are not
    // touched here; the M4 #52 home routes handle their own.
    throw new ValidationFailedError({ reason: 'not a marina home' });
  }
  return runInTransaction(async (client) => {
    // Lock the user + balance, compute net worth.
    const u = await client.query<{ id: string; is_sybil_jailed: boolean }>(
      `SELECT id, is_sybil_jailed FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    if (!u.rows[0]) throw new NotFoundError({ kind: 'user', id: userId });
    if (u.rows[0].is_sybil_jailed) {
      throw new ForbiddenError({ reason: 'sybil_jailed' });
    }
    const b = await client.query<BalanceRow>(
      `SELECT cash_cents, debt_cents FROM balances WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    if (!b.rows[0]) {
      throw new ForbiddenError({ reason: 'no balance row' });
    }
    const netWorth = BigInt(b.rows[0].cash_cents) - BigInt(b.rows[0].debt_cents);
    if (netWorth < BigInt(MARINA_GATE_CENTS)) {
      throw new ForbiddenError({
        reason: 'marina_gate_insufficient_net_worth',
        netWorthCents: netWorth.toString(),
        gateCents: MARINA_GATE_CENTS.toString(),
      });
    }
    return { homeId, userId, admitted: true };
  });
}

/**
 * Create a Cabal invite, open or for one guest.
 *
 * Refused when the host's net worth is below the gate (`403
 * NET_WORTH_TOO_LOW`), when the host already has CABAL_INVITES_PER_HOST
 * pending invites (`409 CONFLICT invites_exhausted`), and for a targeted
 * invite when the guest does not exist (`404`), is the host (`400`), is in a
 * block pair with the host (`403 BLOCKED`), is already a member (`409
 * already_member`) or already has a pending invite from this host (`409
 * invite_pending`). The host row is locked so the cap holds under concurrency.
 * The guest gets the user message `cabal_invite {inviteId, fromUserId,
 * expiresAt (epoch ms), at}`.
 * @param ctx - The application context.
 * @param hostUserId - The caller.
 * @param guestUserId - The invited player, or null for an open invite.
 * @param now - Injectable clock.
 * @returns The invite, with its code (the caller is the host).
 */
export async function createCabalInvite(
  ctx: AppContext,
  hostUserId: string,
  guestUserId: string | null = null,
  now: Date = new Date(),
): Promise<CabalInviteRow> {
  const code = randomBytes(CODE_BYTES).toString('base64url');
  const expiresAt = new Date(now.getTime() + CABAL_INVITE_TTL_DAYS * 86_400_000);
  const invite = await runInTransaction(async (client) => {
    const host = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE id = $1 FOR UPDATE`,
      [hostUserId],
    );
    if (!host.rows[0]) throw new NotFoundError({ kind: 'user', id: hostUserId });
    const bal = await client.query<BalanceRow>(
      `SELECT cash_cents, debt_cents FROM balances WHERE user_id = $1`,
      [hostUserId],
    );
    const netWorth =
      BigInt(bal.rows[0]?.cash_cents ?? '0') - BigInt(bal.rows[0]?.debt_cents ?? '0');
    if (netWorth < BigInt(MARINA_GATE_CENTS)) {
      throw new NetWorthTooLowError({
        netWorthCents: Number(netWorth),
        requiredNetWorthCents: MARINA_GATE_CENTS,
      });
    }
    const pending = await client.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM cabal_invites
        WHERE host_user_id = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > $2`,
      [hostUserId, now.toISOString()],
    );
    if ((pending.rows[0]?.n ?? 0) >= CABAL_INVITES_PER_HOST) {
      throw new ConflictError({ reason: 'invites_exhausted', limit: CABAL_INVITES_PER_HOST });
    }
    if (guestUserId !== null) await checkGuest(client, hostUserId, guestUserId, now);
    const r = await client.query<CabalInviteDbRow>(
      `INSERT INTO cabal_invites
         (invite_id, host_user_id, guest_user_id, code, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${INVITE_COLS}`,
      [uuidv7(), hostUserId, guestUserId, code, expiresAt.toISOString(), now.toISOString()],
    );
    return rowToInvite(r.rows[0]!, hostUserId, now);
  });
  if (guestUserId !== null) {
    // Ring the guest (city room); the code never leaves the host.
    await publishToUser(ctx, guestUserId, 'cabal_invite', {
      inviteId: invite.inviteId,
      fromUserId: hostUserId,
      expiresAt: expiresAt.getTime(),
      at: now.getTime(),
    });
  }
  return invite;
}

type TxClient = Parameters<Parameters<typeof runInTransaction>[0]>[0];

/** Whether two players are in a block pair (either direction). */
async function isBlockedPair(client: TxClient, a: string, b: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM blocks
      WHERE (blocker_user_id = $1 AND blocked_user_id = $2)
         OR (blocker_user_id = $2 AND blocked_user_id = $1)
      LIMIT 1`,
    [a, b],
  );
  return (r.rowCount ?? 0) > 0;
}

/** The targeted-invite checks on the guest (see createCabalInvite). */
async function checkGuest(
  client: TxClient,
  hostUserId: string,
  guestUserId: string,
  now: Date,
): Promise<void> {
  if (guestUserId === hostUserId) {
    throw new ValidationFailedError({ field: 'guestUserId', reason: 'self_invite' });
  }
  const g = await client.query(`SELECT 1 FROM users WHERE id = $1`, [guestUserId]);
  if ((g.rowCount ?? 0) === 0) throw new NotFoundError({ kind: 'user', id: guestUserId });
  if (await isBlockedPair(client, hostUserId, guestUserId)) throw new BlockedError();
  const member = await client.query(
    `SELECT 1 FROM cabal_invites WHERE guest_user_id = $1 AND used_at IS NOT NULL LIMIT 1`,
    [guestUserId],
  );
  if ((member.rowCount ?? 0) > 0) throw new ConflictError({ reason: 'already_member' });
  const dup = await client.query(
    `SELECT 1 FROM cabal_invites
      WHERE host_user_id = $1 AND guest_user_id = $2
        AND used_at IS NULL AND revoked_at IS NULL AND expires_at > $3
      LIMIT 1`,
    [hostUserId, guestUserId, now.toISOString()],
  );
  if ((dup.rowCount ?? 0) > 0) throw new ConflictError({ reason: 'invite_pending' });
}

/**
 * Redeem a Cabal invite. A targeted invite is only for its guest; a revoked,
 * used or expired one is refused, and so is a block pair with the host.
 */
export async function acceptCabalInvite(
  _ctx: AppContext,
  guestUserId: string,
  inviteId: string,
  now: Date = new Date(),
): Promise<CabalInviteRow> {
  return runInTransaction(async (client) => {
    const r = await client.query<CabalInviteDbRow>(
      `SELECT ${INVITE_COLS} FROM cabal_invites WHERE invite_id = $1 FOR UPDATE`,
      [inviteId],
    );
    const inv = r.rows[0];
    if (!inv) throw new NotFoundError({ kind: 'cabal_invite', id: inviteId });
    if (inv.host_user_id === guestUserId) {
      throw new ValidationFailedError({ reason: 'cannot accept your own invite' });
    }
    if (inv.guest_user_id !== null && inv.guest_user_id !== guestUserId) {
      // A targeted invite is not a bearer token: knowing its id is not enough.
      throw new ForbiddenError({ reason: 'not_guest' });
    }
    if (inv.revoked_at !== null) {
      throw new ForbiddenError({ reason: 'invite revoked' });
    }
    if (inv.used_at !== null) {
      throw new ForbiddenError({ reason: 'invite already used' });
    }
    if (new Date(inv.expires_at).getTime() <= now.getTime()) {
      throw new ForbiddenError({ reason: 'invite expired' });
    }
    if (await isBlockedPair(client, inv.host_user_id, guestUserId)) throw new BlockedError();
    const upd = await client.query<CabalInviteDbRow>(
      `UPDATE cabal_invites SET guest_user_id = $1, used_at = $2
       WHERE invite_id = $3
       RETURNING ${INVITE_COLS}`,
      [guestUserId, now.toISOString(), inviteId],
    );
    return rowToInvite(upd.rows[0]!, guestUserId, now);
  });
}

/**
 * Revoke a pending invite. Only its host may (`403 FORBIDDEN not_host`); an
 * accepted, expired or already revoked invite is `409 CONFLICT not_pending`.
 * @param _ctx - The application context.
 * @param hostUserId - The caller.
 * @param inviteId - The invite.
 * @param now - Injectable clock.
 * @returns The invite with `status: 'revoked'`.
 */
export async function revokeCabalInvite(
  _ctx: AppContext,
  hostUserId: string,
  inviteId: string,
  now: Date = new Date(),
): Promise<CabalInviteRow> {
  return runInTransaction(async (client) => {
    const r = await client.query<CabalInviteDbRow>(
      `SELECT ${INVITE_COLS} FROM cabal_invites WHERE invite_id = $1 FOR UPDATE`,
      [inviteId],
    );
    const inv = r.rows[0];
    if (!inv) throw new NotFoundError({ kind: 'cabal_invite', id: inviteId });
    if (inv.host_user_id !== hostUserId) throw new ForbiddenError({ reason: 'not_host' });
    const status = inviteStatus(inv, now);
    if (status !== 'pending') throw new ConflictError({ reason: 'not_pending', status });
    const upd = await client.query<CabalInviteDbRow>(
      `UPDATE cabal_invites SET revoked_at = $1 WHERE invite_id = $2 RETURNING ${INVITE_COLS}`,
      [now.toISOString(), inviteId],
    );
    return rowToInvite(upd.rows[0]!, hostUserId, now);
  });
}

/** List Cabal invites. Restricted to caller's invites (as host or guest). */
export async function listCabalInvites(
  ctx: AppContext,
  callerId: string,
  filter: { hostUserId?: string; guestUserId?: string; used?: boolean },
  limit: number = 30,
): Promise<CabalInviteRow[]> {
  if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
    throw new ValidationFailedError({ reason: 'limit must be 1..100' });
  }
  const where: string[] = [];
  const params: unknown[] = [];

  // B2 fix: Always filter to caller's invites (as host or guest)
  params.push(callerId);
  where.push(`(host_user_id = $${params.length} OR guest_user_id = $${params.length})`);

  if (filter.hostUserId !== undefined) {
    params.push(filter.hostUserId);
    where.push(`host_user_id = $${params.length}`);
  }
  if (filter.guestUserId !== undefined) {
    params.push(filter.guestUserId);
    where.push(`guest_user_id = $${params.length}`);
  }
  if (filter.used === true) where.push(`used_at IS NOT NULL`);
  if (filter.used === false) where.push(`used_at IS NULL`);
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  params.push(limit);
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<CabalInviteDbRow>(
      `SELECT ${INVITE_COLS}
       FROM cabal_invites ${whereClause}
       ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
  });
  const now = new Date();
  return r.rows.map((row) => rowToInvite(row, callerId, now));
}

/** revoked > accepted > expired > pending. */
function inviteStatus(r: CabalInviteDbRow, now: Date): CabalInviteStatus {
  if (r.revoked_at !== null) return 'revoked';
  if (r.used_at !== null) return 'accepted';
  if (r.expires_at.getTime() <= now.getTime()) return 'expired';
  return 'pending';
}

/**
 * @param r - The row.
 * @param callerId - Who is asking; only the host sees the bearer code.
 * @param now - For the derived status.
 */
function rowToInvite(r: CabalInviteDbRow, callerId: string, now: Date): CabalInviteRow {
  return {
    inviteId: r.invite_id,
    hostUserId: r.host_user_id,
    guestUserId: r.guest_user_id,
    ...(callerId === r.host_user_id ? { code: r.code } : {}),
    status: inviteStatus(r, now),
    usedAt: r.used_at ? r.used_at.toISOString() : null,
    revokedAt: r.revoked_at ? r.revoked_at.toISOString() : null,
    expiresAt: r.expires_at.toISOString(),
    createdAt: r.created_at.toISOString(),
  };
}

export interface VenueAccessRow {
  readonly venueId: string;
  readonly allowed: boolean;
  readonly reasonCode: string | null;
  readonly requiredNetWorthCents: number | null;
  readonly netWorthCents: number;
  readonly membershipRequired: boolean;
  readonly isMember: boolean;
  /** Areas of this venue my career-ladder rank unlocks (e.g. `vip_booth`); [] if none. */
  readonly careerAreas: readonly string[];
}

/**
 * Whether the caller may enter a gated venue, and why not.
 *
 * dubai_marina is net-worth gated, cabal_lounge needs membership and
 * sybil_barn is only for jailed players. Everything else is open. The
 * client calls this before joinOrCreate so it can explain a refusal
 * instead of failing the join blind.
 * @param ctx - The application context.
 * @param userId - The calling user.
 * @param venueId - The venue being entered.
 * @returns The access decision.
 */
export async function getVenueAccess(
  ctx: AppContext,
  userId: string,
  venueId: string,
): Promise<VenueAccessRow> {
  const state = await ctx.db.withConnection(async (c) => {
    const bal = await c.query<BalanceRow>(
      'SELECT cash_cents, debt_cents FROM balances WHERE user_id = $1',
      [userId],
    );
    const jail = await c.query<{ is_sybil_jailed: boolean }>(
      'SELECT is_sybil_jailed FROM users WHERE id = $1',
      [userId],
    );
    const member = await c.query<{ invite_id: string }>(
      `SELECT invite_id FROM cabal_invites
        WHERE guest_user_id = $1 AND used_at IS NOT NULL
        LIMIT 1`,
      [userId],
    );
    return {
      netWorth: Number(bal.rows[0]?.cash_cents ?? '0') - Number(bal.rows[0]?.debt_cents ?? '0'),
      jailed: jail.rows[0]?.is_sybil_jailed ?? false,
      isMember: (member.rowCount ?? 0) > 0,
    };
  });

  const careerAreas = await careerAreasAt(ctx, userId, venueId);
  // Police custody: a jailed player may only be in CT Jail until bail or the timer.
  const custody = await ctx.db.withConnection((c) => activeJail(c, userId, new Date()));
  const base = {
    venueId,
    careerAreas,
    netWorthCents: state.netWorth,
    requiredNetWorthCents: null as number | null,
    membershipRequired: false,
    isMember: state.isMember,
  };

  if (custody && venueId !== JAIL_VENUE_ID) {
    return { ...base, allowed: false, reasonCode: 'JAILED' };
  }
  if (venueId === 'dubai_marina') {
    const allowed = state.netWorth >= MARINA_GATE_CENTS;
    return {
      ...base,
      requiredNetWorthCents: MARINA_GATE_CENTS,
      allowed,
      reasonCode: allowed ? null : 'NET_WORTH_TOO_LOW',
    };
  }
  if (venueId === 'cabal_lounge') {
    return {
      ...base,
      membershipRequired: true,
      allowed: state.isMember,
      reasonCode: state.isMember ? null : 'NOT_A_MEMBER',
    };
  }
  if (venueId === 'sybil_barn') {
    return {
      ...base,
      allowed: state.jailed,
      reasonCode: state.jailed ? null : 'NOT_JAILED',
    };
  }
  return { ...base, allowed: true, reasonCode: null };
}

export interface CabalMembershipRow {
  readonly member: boolean;
  readonly since: string | null;
  readonly expiresAt: string | null;
  readonly invitedByUserId: string | null;
  readonly invitesRemaining: number;
  readonly hostGateCents: number;
}

/**
 * My Cabal Lounge membership and how many invites I have left.
 * @param ctx - The application context.
 * @param userId - The calling user.
 * @returns The membership record.
 */
export async function getMyCabal(ctx: AppContext, userId: string): Promise<CabalMembershipRow> {
  const r = await ctx.db.withConnection(async (c) => {
    const mine = await c.query<CabalInviteDbRow>(
      `SELECT ${INVITE_COLS}
         FROM cabal_invites
        WHERE guest_user_id = $1 AND used_at IS NOT NULL
        ORDER BY used_at ASC
        LIMIT 1`,
      [userId],
    );
    const issued = await c.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM cabal_invites
        WHERE host_user_id = $1 AND used_at IS NULL AND revoked_at IS NULL
          AND expires_at > now()`,
      [userId],
    );
    return { mine: mine.rows[0], issued: Number(issued.rows[0]?.n ?? '0') };
  });
  const row = r.mine;
  const remaining = Math.max(0, CABAL_INVITES_PER_HOST - r.issued);
  return {
    member: row !== undefined,
    since: row?.used_at ? row.used_at.toISOString() : null,
    expiresAt: row?.expires_at ? row.expires_at.toISOString() : null,
    invitedByUserId: row?.host_user_id ?? null,
    invitesRemaining: remaining,
    hostGateCents: MARINA_GATE_CENTS,
  };
}
