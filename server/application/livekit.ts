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
import { RoomServiceClient } from 'livekit-server-sdk';
import type { AppContext } from './context.js';
import {
  createRtcTokenIssuer,
  type MintOptions,
  type RtcTokenIssuer,
  type RtcKind,
} from '../shared/livekit/token.js';

export type { RtcKind } from '../shared/livekit/token.js';

export interface MintRtcTokenArgs {
  readonly userId: string;
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
  /** Mint a LiveKit access token for `{kind}:{id}` with identity=userId. */
  mintRtcToken(args: MintRtcTokenArgs): Promise<MintedRtcToken>;
  /** Set `canPublish` on a participant in a LiveKit room. */
  setParticipantCanPublish(
    ctx: AppContext,
    args: { kind: RtcKind; id: string; identity: string; canPublish: boolean },
  ): Promise<void>;
  /** End (delete) a LiveKit room. Idempotent — 404 from LiveKit is OK. */
  endRoom(ctx: AppContext, args: { kind: RtcKind; id: string }): Promise<void>;
  /** True if the LiveKit HTTP API is reachable; for /readyz. */
  ping(ctx: AppContext): Promise<boolean>;
}

/**
 * Room name is `{kind}:{id}`. Pure function so the realtime room
 * code and the contract endpoints can derive the same string.
 */
export function roomName(kind: RtcKind, id: string): string {
  return `${kind}:${id}`;
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
        userId: args.userId,
        canPublish: args.canPublish ?? defaultPublish,
        canSubscribe: args.canSubscribe,
        ttlSec: args.ttlSec,
      };
      const minted = await issuer.mint(opts);
      return {
        token: minted.token,
        url: minted.url,
        roomName: roomName(args.kind, args.id),
        identity: args.userId,
        expiresAt: minted.expiresAt,
        canPublish: minted.canPublish,
      };
    },

    async setParticipantCanPublish(ctx, args) {
      const rs = client(ctx);
      const name = roomName(args.kind, args.id);
      await rs.updateParticipant(name, args.identity, undefined, {
        canPublish: args.canPublish,
        canSubscribe: true,
        canPublishData: true,
      });
    },

    async endRoom(ctx, args) {
      const rs = client(ctx);
      const name = roomName(args.kind, args.id);
      try {
        await rs.deleteRoom(name);
      } catch (e) {
        // LiveKit returns 404 if the room is already gone; that is
        // the idempotent outcome we want.
        if (!isNotFound(e)) throw e;
      }
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
  const msg = (e as { message?: string }).message ?? '';
  return /not\s*found|404/i.test(msg);
}
