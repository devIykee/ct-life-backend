/**
 * Market room.
 *
 * One room per game, 0.5 Hz tick, 2,000 client cap. The market
 * engine publishes coin snapshots to Redis; this room reads them
 * and syncs to connected clients.
 */
import { Room } from 'colyseus';
import { MapSchema } from '@colyseus/schema';
import { MarketState, CoinState } from '../../../contract/realtime/states.js';

const PATCH_HZ = 0.5;
const MAX_PLAYERS = 2_000;

export class MarketRoom extends Room {
  static maxClients = MAX_PLAYERS;
  static patchRate = (1 / PATCH_HZ) * 1000;
  declare state: MarketState;

  /**
   * Create market room and initialize coin state.
   * TODO: M3 wires the market engine snapshots here.
   */
  override async onCreate(_options: unknown): Promise<void> {
    this.state = new MarketState();
    this.state.coins = new MapSchema<CoinState>();

    // TODO: M3 wires the market engine snapshots here.
    // The engine publishes to Redis; this room subscribes and
    // syncs state.coins to match.
    this.setSimulationInterval(() => {
      // Placeholder tick for M2. M3 reads from Redis.
    }, 2000);
  }
}
