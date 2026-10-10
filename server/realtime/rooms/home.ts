/**
 * Home realtime room (M4 #52).
 *
 * One Colyseus room per home, filtered by `homeId`, so a host and their
 * guests share a room and two different homes never do. The room was
 * missing entirely, so `POST /v1/homes/{ownerId}/visit` recorded a visit
 * that had nowhere to happen.
 *
 * The player profile is read from the database on join, never from the
 * join options, the same rule the venue room follows (B5). `look` is
 * stored as the contract `Look` object and is flattened to the string[7]
 * the client expects.
 */
import { Room, Client } from 'colyseus';
import { MapSchema } from '@colyseus/schema';
import { HomeState, PlayerState } from '../../../contract/realtime/states.js';
import { createJwtIssuer } from '../../shared/auth/jwt.js';
import { loadConfig } from '../../shared/config/config.js';

const MAX_GUESTS = 16;

const LOOK_SLOTS = [
  'skinTone',
  'headId',
  'hairId',
  'topId',
  'bottomId',
  'shoesId',
  'accId',
] as const;
const LOOK_FALLBACK = ['0', '0', '0', '0', '0', '0', '0'];

/**
 * Flatten a stored character look into the room's string[7].
 * @param raw - The jsonb value read from characters.look.
 * @returns The seven look ids in contract order.
 */
function lookToArray(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.length === LOOK_SLOTS.length ? raw.map((v) => String(v)) : [...LOOK_FALLBACK];
  }
  if (raw !== null && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    return LOOK_SLOTS.map((k, i) => {
      const v = o[k];
      return typeof v === 'string' && v !== '' ? v : LOOK_FALLBACK[i]!;
    });
  }
  return [...LOOK_FALLBACK];
}

export class HomeRoom extends Room {
  declare state: HomeState;

  /**
   * Create the room for one home.
   * @param options - Join options; `homeId` and `ownerId` scope the room.
   */
  override async onCreate(options: Record<string, unknown>): Promise<void> {
    this.state = new HomeState();
    this.state.homeId = String(options.homeId ?? '');
    this.state.ownerId = String(options.ownerId ?? '');
    this.state.players = new MapSchema<PlayerState>();
    this.maxClients = MAX_GUESTS;
    this.patchRate = 100; // 10 Hz, same as a venue: guests walk around.
  }

  /**
   * Admit a guest. The token is verified and the profile comes from the
   * database, so a spoofed name or look in the options is ignored.
   * @param client - The joining client.
   * @param options - Join options; only `token` is trusted.
   */
  override async onJoin(client: Client, options: Record<string, unknown>): Promise<void> {
    const tokenStr = String(options.token ?? '');
    if (tokenStr === '' && !loadConfig().auth.devAuthEnabled) {
      throw new Error('AUTH_REQUIRED');
    }
    let userId = String(options.userId ?? '');
    if (tokenStr !== '') {
      try {
        const claims = await createJwtIssuer().verifyAccess(tokenStr);
        userId = claims.sub;
      } catch (err) {
        throw new Error('INVALID_TOKEN', { cause: err });
      }
    }
    if (userId === '') return;

    const profile = await this.fetchProfile(userId);
    const player = new PlayerState();
    player.userId = userId;
    player.name = profile.name;
    player.skrName = profile.skrName;
    player.isSeeker = profile.isSeeker;
    player.tribeId = profile.tribeId;
    player.minerTier = profile.minerTier;
    player.look = profile.look;
    player.anim = 'loco_idle';
    this.state.players.set(client.sessionId, player);
    client.send('welcome', {
      serverNow: Date.now(),
      homeId: this.state.homeId,
      ownerId: this.state.ownerId,
      isOwner: userId === this.state.ownerId,
    });
  }

  /**
   * Remove the guest from the room.
   * @param client - The leaving client.
   */
  override onLeave(client: Client): void {
    this.state.players.delete(client.sessionId);
  }

  /**
   * Read the player's profile from the database.
   * @param userId - The verified user id.
   * @returns The profile fields the room publishes.
   */
  private async fetchProfile(userId: string): Promise<{
    name: string;
    skrName: string;
    isSeeker: boolean;
    tribeId: string;
    minerTier: string;
    look: string[];
  }> {
    const { buildContext } = await import('../../application/context.js');
    const ctx = buildContext();
    const r = await ctx.db.withConnection(async (c) => {
      return c.query<{
        alias: string;
        skr_name: string | null;
        is_seeker: boolean;
        miner_tier: string;
        tribe_id: string;
        look: unknown;
      }>(
        `SELECT c.alias, u.skr_name, u.is_seeker, u.miner_tier, c.tribe_id, c.look
           FROM characters c
           JOIN users u ON u.id = c.user_id
          WHERE c.user_id = $1
          LIMIT 1`,
        [userId],
      );
    });
    const row = r.rows[0];
    if (!row) {
      return {
        name: 'Anon',
        skrName: '',
        isSeeker: false,
        tribeId: '',
        minerTier: 'none',
        look: [...LOOK_FALLBACK],
      };
    }
    return {
      name: row.alias || 'Anon',
      skrName: row.skr_name || '',
      isSeeker: row.is_seeker || false,
      tribeId: row.tribe_id || '',
      minerTier: row.miner_tier || 'none',
      look: lookToArray(row.look),
    };
  }
}
