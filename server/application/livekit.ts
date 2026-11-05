/**
 * LiveKit application service.
 *
 * Wraps the LiveKit token minter (`server/shared/livekit/token.ts`)
 * and adds the LiveKit RoomServiceClient so the backend can
 * mutate room state: promote a listener to speaker, end a room.
 *
 * Layering: domain (this file). Transport (api/realtime/workers)
 * is the only layer that imports from `server/application`. The
 * boundary check enforces it.
 *
 * Lives in `server/application` rather than `server/shared` because
 * it is composed at the API composition root with the room service
 * client (which talks to the LiveKit HTTP API). Domain code (the
 * shared token issuer) only deals with the JWT minting SDK.
 *
 * The `kind` enum covers the three room types the spec defines:
 *   - `space`      — Space audio rooms (R2)
 *   - `video`      — free 1:1 or group video call
 *   - `paid_call`  — paid video call with escrow
 *   - `venue`      — proximity voice in a venue (kept for R2
 *                    rooms; not actively used in M4 endpoints but
 *                    the room name format `{kind}:{id}` covers it)
 *
 * Room name format `{kind}:{id}` matches the spec section 4
 * "RTC tokens" ("id is the venue instanceId, the spaceId or the
 * callId; the LiveKit identity is the userId"). The `id` is the
 * UUIDv7 the backend generated when opening the room.
 */
import { isMediaUuid, mediaPlayerId } from '../shared/livekit/identity.js';
import { RoomServiceClient } from 'livekit-server-sdk';
import type { AppContext } from './context.js';
import { ValidationFailedError } from '../shared/domain/errors.js';
import {
  canonicalRoomName,
  createRtcTokenIssuer,
  type MintOptions,
  type RtcTokenIssuer,
  type RtcKind,
} from '../shared/livekit/token.js';

export type { RtcKind } from '../shared/livekit/token.js';

export interface MintRtcTokenArgs {
  readonly identity: string;
  readonly kind: RtcKind;
  readonly id: string;
  readonly canPublish?: boolean;
  readonly canSubscribe?: boolean;
  readonly ttlSec?: number;
}

export interface MintedRtcToken {
  readonly token: string;
  readonly url: string;
  readonly roomName: string;
  readonly identity: string;
  readonly expiresAt: number;
  readonly canPublish: boolean;
}

export interface LiveKitService {
  /** Mint a LiveKit access token for a qualified credential identity. */
  mintRtcToken(args: MintRtcTokenArgs): Promise<MintedRtcToken>;
  /** Set `canPublish` on a participant in a LiveKit room; absent participants are a no-op. */
  setParticipantCanPublish(
    ctx: AppContext,
    args: { kind: RtcKind; id: string; identity: string; canPublish: boolean },
  ): Promise<void>;
  /**
   * Disconnect a participant from a LiveKit room (their token stops
   * mattering: LiveKit only checks it on connect). Absent participant or
   * room is a no-op.
   */
  removeParticipant(
    ctx: AppContext,
    args: { kind: RtcKind | 'proximity'; id: string; identity: string; exact?: boolean },
  ): Promise<void>;
  /** End (delete) a LiveKit room. Idempotent — 404 from LiveKit is OK. */
  endRoom(ctx: AppContext, args: { kind: RtcKind; id: string }): Promise<void>;
  participants(ctx: AppContext, room: string): Promise<Array<{ identity: string; sid: string }>>;
  rooms(ctx: AppContext): Promise<string[]>;
  /** True if the LiveKit HTTP API is reachable; for /readyz. */
  ping(ctx: AppContext): Promise<boolean>;
}

/**
 * Room name is `{kind}:{id}`. Pure function so the realtime room
 * code and the contract endpoints can derive the same string.
 */
export function roomName(kind: RtcKind, id: string): string {
  const name = canonicalRoomName(kind, id);
  if (!name) throw new ValidationFailedError({ reason: 'invalid_room_id', kind });
  return name;
}

/**
 * Build the application-level LiveKit service. The token issuer
 * is a thin wrapper over `server/shared/livekit/token.ts`; the
 * `RoomServiceClient` is the LiveKit HTTP API for room/participant
 * mutations.
 *
 * Construction pulls `LIVEKIT_URL` from `ctx.config.livekit.url`.
 * The SDK derives the HTTP URL by replacing `ws://` with
 * `http://` (and `wss://` with `https://`).
 */
export function createLiveKitService(): LiveKitService {
  let cachedClient: RoomServiceClient | null = null;
  let cachedUrl: string | null = null;
  const issuer: RtcTokenIssuer = createRtcTokenIssuer();

  function client(ctx: AppContext): RoomServiceClient {
    const url = httpUrl(ctx.config.livekit.url);
    if (cachedClient && cachedUrl === url) return cachedClient;
    cachedClient = new RoomServiceClient(
      url,
      ctx.config.livekit.apiKey,
      ctx.config.livekit.apiSecret,
      { requestTimeout: 5, failover: false },
    );
    cachedUrl = url;
    return cachedClient;
  }

  return {
    async mintRtcToken(args) {
      // Default: listeners in spaces start with canPublish=false so
      // the host has to promote them (the spec's contract for audio
      // rooms). Other kinds default to canPublish=true.
      const defaultPublish = args.kind !== 'space';
      const opts: MintOptions = {
        kind: args.kind,
        id: args.id,
        identity: args.identity,
        canPublish: args.canPublish ?? defaultPublish,
        canSubscribe: args.canSubscribe,
        ttlSec: args.ttlSec,
      };
      const minted = await issuer.mint(opts);
      return {
        token: minted.token,
        url: minted.url,
        roomName: roomName(args.kind, args.id),
        identity: args.identity,
        expiresAt: minted.expiresAt,
        canPublish: minted.canPublish,
      };
    },

    async setParticipantCanPublish(ctx, args) {
      const rs = client(ctx);
      const name = roomName(args.kind, args.id);
      let identities = [args.identity];
      if (isMediaUuid(args.identity)) {
        try {
          identities = (await rs.listParticipants(name))
            .filter((p) => mediaPlayerId(p.identity) === args.identity)
            .map((p) => p.identity);
        } catch (error) {
          if (!isNotFound(error)) throw error;
          identities = [];
        }
      }
      await settleParticipants([...identities], async (identity) => {
        try {
          await rs.updateParticipant(name, identity, undefined, {
            canPublish: args.canPublish,
            canSubscribe: true,
            canPublishData: true,
          });
        } catch (e) {
          // Not in the room right now: their next token carries the role.
          if (!isNotFound(e)) throw e;
        }
      });
    },

    async removeParticipant(ctx, args) {
      const rs = client(ctx);
      const name = canonicalRoomName(args.kind, args.id);
      if (!name) throw new ValidationFailedError({ reason: 'invalid_room_id', kind: args.kind });
      const identities = new Set([args.identity]);
      if (!args.exact && isMediaUuid(args.identity)) {
        try {
          for (const p of await rs.listParticipants(name))
            if (mediaPlayerId(p.identity) === args.identity) identities.add(p.identity);
        } catch (e) {
          if (!isNotFound(e)) throw e;
        }
        const grants = await ctx.db.withConnection((c) =>
          c.query<{ media_identity: string }>(
            'SELECT media_identity FROM media_access_grants WHERE room_name=$1 AND user_id=$2',
            [name, args.identity],
          ),
        );
        for (const grant of grants.rows) identities.add(grant.media_identity);
      }
      await settleParticipants([...identities], async (identity) => {
        try {
          // Include same-second refreshed grants; the provider permits a cutoff within 60 seconds.
          await rs.removeParticipant(name, identity, {
            revokeTokenTs: BigInt(Math.floor(Date.now() / 1000) + 5),
          });
        } catch (e) {
          // Already gone (or the room is): that is the outcome we want.
          if (!isNotFound(e)) throw e;
        }
      });
    },

    async endRoom(ctx, args) {
      const rs = client(ctx),
        name = roomName(args.kind, args.id);
      const failures: unknown[] = [];
      try {
        const grants = await ctx.db.withConnection((c) =>
          c.query<{ media_identity: string }>(
            'SELECT media_identity FROM media_access_grants WHERE room_name=$1 ORDER BY next_check_at LIMIT 128',
            [name],
          ),
        );
        await settleParticipants(
          grants.rows.map((g) => g.media_identity),
          async (identity) => {
            try {
              await rs.removeParticipant(name, identity, {
                revokeTokenTs: BigInt(Math.floor(Date.now() / 1000) + 5),
              });
            } catch (error) {
              if (!isNotFound(error)) throw error;
            }
          },
        );
      } catch (error) {
        failures.push(error);
      }
      try {
        await rs.deleteRoom(name);
      } catch (error) {
        if (!isNotFound(error)) failures.push(error);
      }
      // Ended room authority makes every remaining grant ineligible; the durable worker retries partial cutoff.
      if (failures.length) throw new AggregateError(failures, 'Room media cutoff incomplete');
    },

    async participants(ctx, room) {
      try {
        return (await client(ctx).listParticipants(room)).map((p) => ({
          identity: p.identity,
          sid: p.sid,
        }));
      } catch (e) {
        if (isNotFound(e)) return [];
        throw e;
      }
    },

    async rooms(ctx) {
      return (await client(ctx).listRooms()).map((r) => r.name);
    },

    async ping(ctx) {
      try {
        const rs = client(ctx);
        // ListRooms returns at least an empty array on a healthy
        // server. Any thrown error means the API is down.
        await rs.listRooms();
        return true;
      } catch {
        return false;
      }
    },
  };
}

function httpUrl(wsUrl: string): string {
  if (wsUrl.startsWith('wss://')) return `https://${wsUrl.slice('wss://'.length)}`;
  if (wsUrl.startsWith('ws://')) return `http://${wsUrl.slice('ws://'.length)}`;
  return wsUrl;
}

function isNotFound(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  return (e as { code?: string }).code === 'not_found';
}

async function settleParticipants(
  identities: string[],
  visit: (identity: string) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const failures: unknown[] = [];
  await Promise.all(
    Array.from({ length: Math.min(4, identities.length) }, async () => {
      while (cursor < identities.length) {
        const identity = identities[cursor++]!;
        try {
          await visit(identity);
        } catch (error) {
          failures.push(error);
        }
      }
    }),
  );
  if (failures.length) throw new AggregateError(failures, 'Participant update incomplete');
}
