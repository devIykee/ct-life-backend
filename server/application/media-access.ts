/** Durable media grants. A provider disconnect is separate from application credential revocation. */
import type { AppContext } from './context.js';
import type { MintedRtcToken, MintRtcTokenArgs, RtcKind } from './livekit.js';
import { canonicalRoomName } from '../shared/livekit/token.js';
import { ValidationFailedError } from '../shared/domain/errors.js';
import { runInTransaction } from '../shared/db/uow.js';
import {
  mediaIdentity,
  mediaPlayerId,
  parseMediaIdentity,
  isMediaUuid,
} from '../shared/livekit/identity.js';
import {
  resolveLoginCredentialOn,
  credentialRevoked,
  type CredentialClaims,
  type LoginIdentityRevokedEvent,
} from './login-credentials.js';
import { parseStreetVoiceId, checkStreetVoiceJoin } from './street-voice.js';
import { assertInVenueInstance } from './venue-voice.js';
import { spaceRtcAccess } from './spaces.js';
import { isCapabilityOn } from './capabilities.js';

/** Provider refreshes carry at least ten minutes. Keep a clock/observation margin too. */
export const MEDIA_REFRESH_TAIL_SEC = 660;
const SWEEP_BATCH = 128;
type GrantRow = { room_name: string; media_identity: string; retain_until: Date };

/** Mint and register while holding the account lock also held by removal/deletion. */
export async function mintMediaGrant(
  ctx: AppContext,
  actor: CredentialClaims,
  args: Omit<MintRtcTokenArgs, 'identity'>,
): Promise<MintedRtcToken> {
  const canonical = canonicalRoomName(args.kind, args.id);
  if (!canonical || !isGameMediaRoom(canonical))
    throw new ValidationFailedError({ reason: 'invalid_media_room' });
  return runInTransaction(
    async (c) => {
      const user = await c.query(
        'SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',
        [actor.sub],
      );
      if (!user.rowCount) throw credentialRevoked();
      const scope = await resolveLoginCredentialOn(c, actor);
      const identity = mediaIdentity(scope);
      const minted = await ctx.livekit.mintRtcToken({ ...args, identity });
      // SDK minting is local signing; no provider I/O is performed under this lock.
      await c.query(
        `INSERT INTO media_access_grants(room_name,media_identity,user_id,login_identity_id,credential_version,issued_expires_at,retain_until)
      VALUES($1,$2,$3,$4,$5,to_timestamp($6),to_timestamp($6+$7))
      ON CONFLICT(room_name,media_identity) DO UPDATE SET
        issued_expires_at=GREATEST(media_access_grants.issued_expires_at,EXCLUDED.issued_expires_at),
        retain_until=GREATEST(media_access_grants.retain_until,EXCLUDED.retain_until),next_check_at=clock_timestamp(),cutoff_succeeded_at=NULL`,
        [
          minted.roomName,
          identity,
          scope.userId,
          scope.identityId,
          scope.version,
          minted.expiresAt,
          MEDIA_REFRESH_TAIL_SEC,
        ],
      );
      return minted;
    },
    { isolation: 'read committed', maxRetries: 0 },
    ctx.db,
  );
}

/** Only CT Life's room namespaces are eligible for account-access enforcement. */
export function isGameMediaRoom(room: string): boolean {
  if (room.startsWith('proximity:')) return parseStreetVoiceId(room) !== null;
  if (room.startsWith('venue:')) return /^[A-Za-z0-9_-]{1,128}$/.test(room.slice(6));
  const split = room.indexOf(':');
  return (
    ['space', 'video', 'call', 'paid_call'].includes(room.slice(0, split)) &&
    isMediaUuid(room.slice(split + 1))
  );
}

/** Exact raw identity only: removing a legacy grant must not remove retained qualified siblings. */
export async function removeMediaIdentity(
  ctx: AppContext,
  room: string,
  identity: string,
): Promise<void> {
  if (!isGameMediaRoom(room)) return;
  const split = room.indexOf(':');
  await ctx.livekit.removeParticipant(ctx, {
    kind: room.slice(0, split) as RtcKind,
    id: room.slice(split + 1),
    identity,
    exact: true,
  });
}

/** First successful cutoff establishes a full refreshed-token tail even if removal hides the participant from inventory. */
async function cutoffInactiveGrant(ctx: AppContext, room: string, identity: string): Promise<void> {
  await removeMediaIdentity(ctx, room, identity);
  await ctx.db.withConnection((c) =>
    c.query(
      `UPDATE media_access_grants SET
     retain_until=CASE WHEN cutoff_succeeded_at IS NULL THEN GREATEST(retain_until,clock_timestamp()+$3*interval '1 second') ELSE retain_until END,
     cutoff_succeeded_at=COALESCE(cutoff_succeeded_at,clock_timestamp())
     WHERE room_name=$1 AND media_identity=$2`,
      [room, identity, MEDIA_REFRESH_TAIL_SEC],
    ),
  );
}

/** An issued-but-never-used grant must still be found when its credential is removed. */
export async function revokeCredentialMedia(
  ctx: AppContext,
  event: LoginIdentityRevokedEvent,
): Promise<void> {
  const rows = await ctx.db.withConnection((c) =>
    c.query<GrantRow>(
      `SELECT room_name,media_identity,retain_until FROM media_access_grants
     WHERE user_id=$1 AND login_identity_id=$2 AND credential_version<$3 ORDER BY next_check_at LIMIT $4`,
      [event.userId, event.identityId, event.minVersion, 8],
    ),
  );
  await eachBounded(rows.rows, async (row) => {
    await cutoffInactiveGrant(ctx, row.room_name, row.media_identity);
  });
}

/** The registry binds signed credentials to the particular room; parsing alone grants nothing. */
export async function mediaGrantActive(
  ctx: AppContext,
  room: string,
  identity: string,
): Promise<boolean> {
  const scope = parseMediaIdentity(identity);
  if (!scope) return false;
  const grant = await ctx.db.withConnection((c) =>
    c.query(
      `SELECT 1 FROM media_access_grants g JOIN login_identities i ON i.id=g.login_identity_id AND i.user_id=g.user_id
     JOIN users u ON u.id=g.user_id WHERE g.room_name=$1 AND g.media_identity=$2
     AND i.session_version=g.credential_version AND i.revoked_at IS NULL AND u.deleted_at IS NULL
     AND (i.network<>'solana:mainnet' OR i.address=u.wallet)`,
      [room, identity],
    ),
  );
  return !!grant.rowCount && (await playerRoomMediaAccess(ctx, room, scope.userId));
}

/** Room membership remains authoritative even when the sign-in credential itself is valid. */
async function playerRoomMediaAccess(
  ctx: AppContext,
  room: string,
  player: string,
): Promise<boolean> {
  if (!isGameMediaRoom(room)) return false;
  const split = room.indexOf(':'),
    kind = room.slice(0, split),
    id = room.slice(split + 1);
  try {
    if (kind === 'space') {
      await spaceRtcAccess(ctx, id, player);
      return true;
    }
    if (kind === 'venue') {
      await assertInVenueInstance(ctx, id, player);
      return true;
    }
    if (kind === 'proximity')
      return (
        isCapabilityOn(ctx, 'streetVoice') &&
        (await checkStreetVoiceJoin(ctx, room, player, Date.now())) === null
      );
    const member = await ctx.db.withConnection((c) =>
      c.query(
        `SELECT 1 FROM voice_speakers s JOIN voice_rooms r ON r.room_id=s.room_id
       WHERE s.room_id=$1 AND s.user_id=$2 AND s.left_at IS NULL AND r.status='live' LIMIT 1`,
        [room, player],
      ),
    );
    return !!member.rowCount;
  } catch (error) {
    if (
      ['NOT_FOUND', 'FORBIDDEN', 'NOT_IN_VENUE', 'NOT_IN_AREA'].includes(
        (error as { code?: string }).code ?? '',
      )
    )
      return false;
    throw error;
  }
}

/** Reconcile a current provider participant, including refreshed tokens and lost webhook events. */
export async function reconcileMediaParticipant(
  ctx: AppContext,
  room: string,
  identity: string,
): Promise<boolean> {
  if (!isGameMediaRoom(room)) return true;
  try {
    if (await mediaGrantActive(ctx, room, identity)) {
      await ctx.db.withConnection((c) =>
        c.query(
          `UPDATE media_access_grants SET last_seen_at=clock_timestamp(),
         retain_until=GREATEST(retain_until,clock_timestamp()+$3*interval '1 second')
         WHERE room_name=$1 AND media_identity=$2`,
          [room, identity, MEDIA_REFRESH_TAIL_SEC],
        ),
      );
      return true;
    }
  } catch (error) {
    // Authority outage is not permanent credential rejection, but existing media cannot stay authorised unchecked.
    await removeMediaIdentity(ctx, room, identity);
    throw error;
  }
  // Keep the refreshed-token obligation even when this grant's credential has gone away.
  try {
    await ctx.db.withConnection((c) =>
      c.query(
        `UPDATE media_access_grants SET last_seen_at=clock_timestamp(),
     retain_until=GREATEST(retain_until,clock_timestamp()+$3*interval '1 second')
     WHERE room_name=$1 AND media_identity=$2`,
        [room, identity, MEDIA_REFRESH_TAIL_SEC],
      ),
    );
  } finally {
    await cutoffInactiveGrant(ctx, room, identity);
  }
  return false;
}

/** Read live inventory before processing a leave; delayed old events cannot erase current sibling presence. */
export async function hasPlayerMedia(
  ctx: AppContext,
  room: string,
  player: string,
): Promise<boolean> {
  const identities = (await ctx.livekit.participants(ctx, room))
    .filter((p) => parseMediaIdentity(p.identity)?.userId === player)
    .map((p) => p.identity);
  if (!identities.length) return false;
  const active = await ctx.db.withConnection((c) =>
    c.query(
      `SELECT 1 FROM media_access_grants g JOIN login_identities i ON i.id=g.login_identity_id AND i.user_id=g.user_id
     JOIN users u ON u.id=g.user_id WHERE g.room_name=$1 AND g.media_identity=ANY($2::text[])
     AND i.session_version=g.credential_version AND i.revoked_at IS NULL AND u.deleted_at IS NULL
     AND (i.network<>'solana:mainnet' OR i.address=u.wallet) LIMIT 1`,
      [room, identities],
    ),
  );
  return !!active.rowCount && (await playerRoomMediaAccess(ctx, room, player));
}

/** A leave can change player-level call state only for an actual member with no remaining media identity. */
export async function isPlayerMediaDeparture(
  ctx: AppContext,
  room: string,
  identity: string,
): Promise<boolean> {
  const player = mediaPlayerId(identity);
  if (!player || !isGameMediaRoom(room)) return false;
  const member = await ctx.db.withConnection((c) =>
    c.query('SELECT 1 FROM voice_speakers WHERE room_id=$1 AND user_id=$2 LIMIT 1', [room, player]),
  );
  return !!member.rowCount && !(await hasPlayerMedia(ctx, room, player));
}

/** Fair bounded registry scan plus provider inventory. No obligation is deleted on an unverified absence. */
export async function sweepMediaGrants(
  ctx: AppContext,
  roomCursor = 0,
  participantOffsets: Record<string, number> = {},
): Promise<{
  nextRoomCursor: number;
  participantOffsets: Record<string, number>;
  checked: number;
  failures: number;
}> {
  let failures = 0;
  const observed = new Map<string, Set<string>>();
  const rows = await ctx.db.withConnection((c) =>
    c.query<GrantRow>(
      `SELECT g.room_name,g.media_identity,g.retain_until FROM media_access_grants g
     LEFT JOIN login_identities i ON i.id=g.login_identity_id AND i.user_id=g.user_id LEFT JOIN users u ON u.id=g.user_id
     WHERE g.next_check_at<=clock_timestamp()
     ORDER BY CASE WHEN g.cutoff_succeeded_at IS NULL AND (i.id IS NULL OR i.revoked_at IS NOT NULL OR i.session_version<>g.credential_version OR u.deleted_at IS NOT NULL) THEN 0 ELSE 1 END,
     g.next_check_at,g.room_name,g.media_identity LIMIT $1`,
      [SWEEP_BATCH],
    ),
  );
  await eachBounded(rows.rows, async (row) => {
    // Advance every selected row before authority/provider work, including partial authority outages.
    try {
      await ctx.db.withConnection((c) =>
        c.query(
          `UPDATE media_access_grants SET next_check_at=clock_timestamp()+interval '15 seconds'
       WHERE room_name=$1 AND media_identity=$2`,
          [row.room_name, row.media_identity],
        ),
      );
    } catch (error) {
      // A scheduling write failure must not leave unchecked media connected or erase its obligation.
      await removeMediaIdentity(ctx, row.room_name, row.media_identity);
      throw error;
    }
    // Inventory failure must not stop a known revoked/offline grant from receiving its cutoff.
    let active: boolean;
    try {
      active = await mediaGrantActive(ctx, row.room_name, row.media_identity);
    } catch (error) {
      await removeMediaIdentity(ctx, row.room_name, row.media_identity);
      throw error;
    }
    if (!active) await cutoffInactiveGrant(ctx, row.room_name, row.media_identity);
    let present = observed.get(row.room_name);
    if (!present) {
      present = new Set(
        (await ctx.livekit.participants(ctx, row.room_name)).map((p) => p.identity),
      );
      observed.set(row.room_name, present);
    }
    if (present.has(row.media_identity)) {
      await reconcileMediaParticipant(ctx, row.room_name, row.media_identity);
      return;
    }
    // Refresh-tail retention is checked against the durable row, not an earlier inventory snapshot.
    await ctx.db.withConnection((c) =>
      c.query(
        `DELETE FROM media_access_grants WHERE room_name=$1 AND media_identity=$2 AND retain_until<clock_timestamp()`,
        [row.room_name, row.media_identity],
      ),
    );
  }).catch(() => {
    failures++;
  });
  // Inventory is a bounded backstop for missed webhooks and old unregistered grants.
  // Four participants per room across 32 rooms gives a global 128-participant budget and round-robin progress.
  let rooms: string[] = [];
  try {
    rooms = (await ctx.livekit.rooms(ctx)).filter(isGameMediaRoom).sort();
  } catch {
    failures++;
  }
  if (roomCursor >= rooms.length) roomCursor = 0;
  const offsets: Record<string, number> = Object.fromEntries(
    Object.entries(participantOffsets).filter(([room]) => rooms.includes(room)),
  );
  const selected = rooms.slice(roomCursor, roomCursor + 32);
  await eachBounded(selected, async (room) => {
    const participants = (await ctx.livekit.participants(ctx, room)).sort((a, b) =>
      a.identity.localeCompare(b.identity),
    );
    let start = offsets[room] ?? 0;
    if (start >= participants.length) start = 0;
    const chunk = participants.slice(start, start + 4);
    offsets[room] = start + 4 >= participants.length ? 0 : start + 4;
    await eachBounded(chunk, (p) =>
      reconcileMediaParticipant(ctx, room, p.identity).then(() => {}),
    );
  }).catch(() => {
    failures++;
  });
  return {
    nextRoomCursor: roomCursor + 32 >= rooms.length ? 0 : roomCursor + 32,
    participantOffsets: offsets,
    checked: rows.rows.length,
    failures,
  };
}

/** Await every operation, including failed calls, before allowing the next pass. SDK requests have an abort timeout. */
async function eachBounded<T>(
  items: readonly T[],
  visit: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const failures: unknown[] = [];
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (cursor < items.length) {
        const item = items[cursor++]!;
        try {
          await visit(item);
        } catch (error) {
          failures.push(error);
        }
      }
    }),
  );
  if (failures.length) throw new AggregateError(failures, 'Media access reconciliation failed');
}
