/**
 * LiveKit token minter.
 *
 * Wraps `livekit-server-sdk` AccessToken so the rest of the backend
 * can mint RTC tokens for venues, spaces and paid calls. The
 * LiveKit room name is `{kind}:{id}` per the contract (contract
 * section 4: "RTC tokens" — id is the venue instanceId, the spaceId
 * or the callId; the LiveKit identity is the userId).
 *
 * Tokens are short-lived (default 1 h). The `canPublish` flag is
 * set by the caller: venues and paid calls allow publishing;
 * Spaces listeners start with canPublish=false and the host promotes
 * them via the LiveKit server API.
 */
import { AccessToken, type VideoGrant } from 'livekit-server-sdk';
import { loadConfig } from '../config/config.js';

export type RtcKind = 'venue' | 'space' | 'video' | 'paid_call';

const ROOM_PREFIXES = ['venue', 'space', 'video', 'paid_call', 'call', 'proximity'] as const;

/**
 * The one LiveKit room name for `{kind}:{id}`. Accepts a bare id or one
 * matching `{kind}:` prefix (Space ids are stored as `space:<uuid>`), so the
 * prefix is never doubled. Returns null for an empty id or a prefix of a
 * different kind.
 */
export function canonicalRoomName(kind: string, id: string): string | null {
  const bare = id.startsWith(`${kind}:`) ? id.slice(kind.length + 1) : id;
  if (bare.length === 0) return null;
  if (ROOM_PREFIXES.some((p) => bare.startsWith(`${p}:`))) return null;
  return `${kind}:${bare}`;
}

export interface MintOptions {
  readonly kind: RtcKind;
  readonly id: string;
  readonly userId: string;
  readonly ttlSec?: number;
  readonly canPublish?: boolean;
  readonly canSubscribe?: boolean;
  readonly metadata?: Record<string, string>;
}

export interface RtcTokenIssuer {
  mint(
    opts: MintOptions,
  ): Promise<{ token: string; url: string; expiresAt: number; canPublish: boolean }>;
}

const DEFAULT_TTL_SEC = 60 * 60;

/**
 * Build the process-wide LiveKit token issuer. Reads the LiveKit
 * URL and API key/secret from `Config.livekit`. The returned object
 * mints short-lived JWTs for the Unity client to join venues, spaces
 * and paid calls.
 */
export function createRtcTokenIssuer(): RtcTokenIssuer {
  const cfg = loadConfig();
  return {
    async mint(opts) {
      const ttl = opts.ttlSec ?? DEFAULT_TTL_SEC;
      const at = new AccessToken(cfg.livekit.apiKey, cfg.livekit.apiSecret, {
        identity: opts.userId,
        ttl,
        metadata: opts.metadata ? JSON.stringify(opts.metadata) : undefined,
      });
      const room = canonicalRoomName(opts.kind, opts.id);
      if (!room) throw new Error(`invalid ${opts.kind} room id`);
      const grant: VideoGrant = {
        room,
        roomJoin: true,
        canPublish: opts.canPublish ?? true,
        canSubscribe: opts.canSubscribe ?? true,
        canPublishData: true,
      };
      at.addGrant(grant);
      const token = await at.toJwt();
      const expiresAt = Math.floor(Date.now() / 1000) + ttl;
      return {
        token,
        url: cfg.livekit.url,
        expiresAt,
        canPublish: opts.canPublish ?? true,
      };
    },
  };
}
