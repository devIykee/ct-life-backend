/**
 * Market room.
 *
 * One room per game, 0.5 Hz tick, 2,000 client cap. The market
 * engine publishes coin snapshots to Redis; this room reads them
 * and syncs to connected clients.
 */
import { Room, Client } from 'colyseus';
import { MapSchema } from '@colyseus/schema';
import { MarketState, CoinState } from '../../../contract/realtime/states.js';
import { createJwtIssuer } from '../../shared/auth/jwt.js';
import { loadConfig } from '../../shared/config/config.js';
import { listMarketCoins } from '../../application/world-pulse.js';
import { BanGuard } from '../ban-guard.js';

const PATCH_HZ = 0.5;
const MAX_PLAYERS = 2_000;
/** Coins broadcast to clients, by market cap. */
const MAX_COINS = 50;

export class MarketRoom extends Room {
  private readonly ban = new BanGuard(this);
  static maxClients = MAX_PLAYERS;
  static patchRate = (1 / PATCH_HZ) * 1000;
  declare state: MarketState;

  /**
   * Create market room and initialize coin state.
   * TODO: M3 wires the market engine snapshots here.
   */
  override async onCreate(_options: unknown): Promise<void> {
    await this.ban.attach();
    this.state = new MarketState();
    this.state.coins = new MapSchema<CoinState>();

    // state.coins used to be left empty behind an "M3 reads from Redis"
    // TODO, so no live price ever reached a client even though the coins
    // table and the trade endpoints were working. Sync it on the tick.
    this.setSimulationInterval(() => {
      void this.syncCoins();
    }, 2000);
    void this.syncCoins();
  }

  /**
   * Mirror the market into state.coins, adding, updating and removing so
   * the MapSchema patch stays minimal.
   */
  private async syncCoins(): Promise<void> {
    try {
      const { buildContext } = await import('../../application/context.js');
      const coins = await listMarketCoins(buildContext(), MAX_COINS);
      const seen = new Set<string>();
      for (const snap of coins) {
        seen.add(snap.coinId);
        let c = this.state.coins.get(snap.coinId);
        if (!c) {
          c = new CoinState();
          this.state.coins.set(snap.coinId, c);
        }
        c.coinId = snap.coinId;
        c.ticker = snap.ticker;
        c.name = snap.name;
        c.stage = snap.stage;
        c.priceMicros = snap.priceMicros;
        c.mcapCents = snap.mcapCents;
        c.vol5mCents = snap.vol5mCents;
        c.change5mBps = snap.change5mBps;
        c.holders = snap.holders;
        c.launchedAt = snap.launchedAt;
        c.playerLaunched = snap.playerLaunched;
        c.templateId = snap.templateId;
      }
      for (const id of [...this.state.coins.keys()]) {
        if (!seen.has(id)) this.state.coins.delete(id);
      }
    } catch {
      // Keep the last broadcast prices; a read failure must not drop the room.
    }
  }

  /**
   * B5 fix: Verify JWT token before allowing join
   */
  override async onJoin(client: Client, options: unknown): Promise<void> {
    const tokenStr = String((options as { token?: string })?.token ?? '');
    // Reject if no token provided and not in dev mode
    if (tokenStr === '' && !loadConfig().auth.devAuthEnabled) {
      throw new Error('AUTH_REQUIRED');
    }
    // Verify the token
    if (tokenStr !== '') {
      try {
        const jwtIssuer = createJwtIssuer();
        const claims = await jwtIssuer.verifyAccess(tokenStr);
        this.ban.track(client, claims.sub ?? '');
        await this.ban.confirm(claims.sub ?? '');
      } catch (err) {
        if ((err as Error).message === 'ACCOUNT_BANNED') throw err;
        throw new Error('INVALID_TOKEN', { cause: err });
      }
    }
  }

  /**
   * Forget the session.
   * @param client - The leaving client.
   */
  override onLeave(client: Client): void {
    this.ban.untrack(client);
  }

  /** Stop listening for bans. */
  override async onDispose(): Promise<void> {
    await this.ban.detach();
  }
}
