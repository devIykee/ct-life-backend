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
import { HOME_ACCESS_CHANNEL } from '../../application/home-units.js';
import { OUTFIT_CHANNEL } from '../movement.js';
import { applyOutfitMessage, loadPlayerState } from '../player.js';

const MAX_GUESTS = 16;
/** Backstop for a missed access event: re-check everyone this often. */
const RECHECK_MS = 30_000;

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

  private readonly userBySession = new Map<string, string>();
  private recheckTimer: ReturnType<typeof setInterval> | null = null;

  private readonly onOutfit = (data: unknown): void => applyOutfitMessage(this.state.players, data);

  /** A guest was removed, or the home was moved out of or evicted: look again. */
  private readonly onAccess = (msg: unknown): void => {
    if ((msg as { homeId?: string } | null)?.homeId === this.state.homeId) void this.recheck();
  };

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
    await this.presence?.subscribe(HOME_ACCESS_CHANNEL, this.onAccess);
    await this.presence?.subscribe(OUTFIT_CHANNEL, this.onOutfit);
    this.recheckTimer = setInterval(() => void this.recheck(), RECHECK_MS);
    this.recheckTimer.unref();
  }

  /**
   * Stop listening and re-checking.
   */
  override async onDispose(): Promise<void> {
    if (this.recheckTimer) clearInterval(this.recheckTimer);
    this.recheckTimer = null;
    await this.presence?.unsubscribe(HOME_ACCESS_CHANNEL, this.onAccess);
    await this.presence?.unsubscribe(OUTFIT_CHANNEL, this.onOutfit);
  }

  /**
   * Show out every client who can no longer enter this home. Joining
   * checks the door once; this enforces revocation afterwards.
   */
  async recheck(): Promise<void> {
    const { buildContext } = await import('../../application/context.js');
    const { canEnterHome } = await import('../../application/homes.js');
    const ctx = buildContext();
    for (const client of [...this.clients]) {
      const userId = this.userBySession.get(client.sessionId);
      if (userId === undefined) continue;
      try {
        if (!(await canEnterHome(ctx, this.state.homeId, userId))) client.leave(4403, 'FORBIDDEN');
      } catch {
        // A database blip must not throw anyone out; the next check retries.
      }
    }
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

    // The door's rule applies to the room too: without this, anyone who knew
    // a home id could join past a locked door. A home without a door stays open.
    const { buildContext } = await import('../../application/context.js');
    const { canEnterHome } = await import('../../application/homes.js');
    if (!(await canEnterHome(buildContext(), this.state.homeId, userId))) {
      throw new Error('FORBIDDEN');
    }

    const profile = await this.fetchProfile(userId);
    const player = new PlayerState();
    player.userId = userId;
    player.name = profile.name;
    player.skrName = profile.skrName;
    player.isSeeker = profile.isSeeker;
    player.tribeId = profile.tribeId;
    player.minerTier = profile.minerTier;
    player.look = profile.look;
    player.outfit = (await loadPlayerState(userId)).outfit;
    player.anim = 'loco_idle';
    this.userBySession.set(client.sessionId, userId);
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
    this.userBySession.delete(client.sessionId);
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
