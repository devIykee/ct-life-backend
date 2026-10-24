/**
 * Dubai Marina + Cabal Lounge gating (M7 #7).
 *
 * Endpoints:
 *
 *   POST /v1/homes/{id}/marina/visit     — gated by net_worth
 *                                          (>= MARINA_GATE_CENTS).
 *   POST /v1/cabal/invites               — host creates a Cabal
 *                                          invite (single-use).
 *   POST /v1/cabal/invites/{id}/accept   — guest redeems; sets
 *                                          guest_user_id + used_at.
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
 *   The Cabal is invite-only. A host creates a 32-char URL-safe
 *   code; the guest redeems via the accept endpoint. The code
 *   is single-use (used_at IS NOT NULL after accept) and expires
 *   after CABAL_INVITE_TTL_DAYS. UNIQUE on code is the floor.
 */
import { runInTransaction } from '../shared/db/uow.js';
import { ForbiddenError, NotFoundError, ValidationFailedError } from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { randomBytes } from 'node:crypto';
import { careerAreasAt } from './ladders.js';
import type { AppContext } from './context.js';

export const MARINA_GATE_CENTS = 10_000_000; // $100,000
const CABAL_INVITE_TTL_DAYS = 7;
const CODE_BYTES = 24; // 32-char base64url

export interface CabalInviteRow {
  readonly inviteId: string;
  readonly hostUserId: string;
  readonly guestUserId: string | null;
  readonly code: string;
  readonly usedAt: string | null;
  readonly expiresAt: string;
  readonly createdAt: string;
}

interface CabalInviteDbRow {
  invite_id: string;
  host_user_id: string;
  guest_user_id: string | null;
  code: string;
  used_at: Date | null;
  expires_at: Date;
  created_at: Date;
}

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

/** Create a Cabal invite. */
export async function createCabalInvite(
  _ctx: AppContext,
  hostUserId: string,
  now: Date = new Date(),
): Promise<CabalInviteRow> {
  const code = randomBytes(CODE_BYTES).toString('base64url');
  const expiresAt = new Date(now.getTime() + CABAL_INVITE_TTL_DAYS * 86_400_000);
  return runInTransaction(async (client) => {
    const r = await client.query<CabalInviteDbRow>(
      `INSERT INTO cabal_invites
         (invite_id, host_user_id, code, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING invite_id, host_user_id, guest_user_id, code, used_at,
                 expires_at, created_at`,
      [uuidv7(), hostUserId, code, expiresAt.toISOString(), now.toISOString()],
    );
    return rowToInvite(r.rows[0]!);
  });
}

/** Redeem a Cabal invite. */
export async function acceptCabalInvite(
  _ctx: AppContext,
  guestUserId: string,
  inviteId: string,
  now: Date = new Date(),
): Promise<CabalInviteRow> {
  return runInTransaction(async (client) => {
    const r = await client.query<CabalInviteDbRow>(
      `SELECT invite_id, host_user_id, guest_user_id, code, used_at,
              expires_at, created_at
       FROM cabal_invites WHERE invite_id = $1 FOR UPDATE`,
      [inviteId],
    );
    const inv = r.rows[0];
    if (!inv) throw new NotFoundError({ kind: 'cabal_invite', id: inviteId });
    if (inv.host_user_id === guestUserId) {
      throw new ValidationFailedError({ reason: 'cannot accept your own invite' });
    }
    if (inv.used_at !== null) {
      throw new ForbiddenError({ reason: 'invite already used' });
    }
    if (new Date(inv.expires_at).getTime() <= now.getTime()) {
      throw new ForbiddenError({ reason: 'invite expired' });
    }
    const upd = await client.query<CabalInviteDbRow>(
      `UPDATE cabal_invites SET guest_user_id = $1, used_at = $2
       WHERE invite_id = $3
       RETURNING invite_id, host_user_id, guest_user_id, code, used_at,
                 expires_at, created_at`,
      [guestUserId, now.toISOString(), inviteId],
    );
    return rowToInvite(upd.rows[0]!);
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
      `SELECT invite_id, host_user_id, guest_user_id, code, used_at,
              expires_at, created_at
       FROM cabal_invites ${whereClause}
       ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
  });
  return r.rows.map(rowToInvite);
}

function rowToInvite(r: CabalInviteDbRow): CabalInviteRow {
  return {
    inviteId: r.invite_id,
    hostUserId: r.host_user_id,
    guestUserId: r.guest_user_id,
    code: r.code,
    usedAt: r.used_at ? r.used_at.toISOString() : null,
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
  const base = {
    venueId,
    careerAreas,
    netWorthCents: state.netWorth,
    requiredNetWorthCents: null as number | null,
    membershipRequired: false,
    isMember: state.isMember,
  };

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

/** Invites a host may have outstanding at once. */
const CABAL_INVITES_PER_HOST = 3;

/**
 * My Cabal Lounge membership and how many invites I have left.
 * @param ctx - The application context.
 * @param userId - The calling user.
 * @returns The membership record.
 */
export async function getMyCabal(ctx: AppContext, userId: string): Promise<CabalMembershipRow> {
  const r = await ctx.db.withConnection(async (c) => {
    const mine = await c.query<CabalInviteDbRow>(
      `SELECT invite_id, host_user_id, guest_user_id, code, used_at, expires_at, created_at
         FROM cabal_invites
        WHERE guest_user_id = $1 AND used_at IS NOT NULL
        ORDER BY used_at ASC
        LIMIT 1`,
      [userId],
    );
    const issued = await c.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM cabal_invites
        WHERE host_user_id = $1 AND used_at IS NULL AND expires_at > now()`,
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
