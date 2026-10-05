/**
 * Market room.
 *
 * One room per game, 0.5 Hz tick, 2,000 client cap. M2 ships a
 * stub: just the timestamp and a placeholder field. M3 wires the
 * real coins from the market engine.
 */
import { Room } from 'colyseus';
import { MarketState } from '../schemas.js';

const PATCH_HZ = 0.5;
const MAX_PLAYERS = 2_000;

export class MarketRoom extends Room {
  static maxClients = MAX_PLAYERS;
  static patchRate = (1 / PATCH_HZ) * 1000;
  declare state: MarketState;
  /**
   *
   */
  override async onCreate(_options: unknown): Promise<void> {
    this.state = new MarketState();
    this.state.ts = Date.now();
    this.state.placeholder = 'market-m3';
    this.setSimulationInterval(() => {
      this.state.ts = Date.now();
    }, 2000);
  }
}
