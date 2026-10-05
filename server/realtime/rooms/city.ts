/**
 * City room.
 *
 * One Colyseus room per game, 1 Hz patch rate, 1,000 client cap
 * (sharded in M3). Carries online count, Mood, active events, and
 * targeted messages to the joined player (dms, payment_confirmed,
 * liquidated, kicked, call_invite, space_update).
 *
 * M2 ships a stub: every player joins, gets the welcome, and the
 * city just broadcasts `event` periodically so clients can render
 * the activity feed. The full event engine is wired in M3 by the
 * workers.
 */
import { Room, Client } from 'colyseus';
import { CityState } from '../schemas.js';

const PATCH_HZ = 1;
const MAX_PLAYERS = 1_000;

export class CityRoom extends Room {
  static maxClients = MAX_PLAYERS;
  static patchRate = PATCH_HZ * 1000;
  declare state: CityState;
  /**
   *
   */
  override async onCreate(_options: unknown): Promise<void> {
    this.state = new CityState();
    this.state.online = 0;
    this.state.mood = 0;
    this.state.metaId = 'meta_v1';
    this.setSimulationInterval((dt) => this.tick(dt), 1000);
  }
  /**
   *
   */
  override onJoin(client: Client): void {
    this.state.online = this.clients.length;
    client.send('welcome', { serverNow: Date.now(), instanceId: this.roomId ?? 'city' });
  }
  /**
   *
   */
  override onLeave(): void {
    this.state.online = this.clients.length;
  }
  private tick(_dt: number): void {
    // M3: subscribe to the EventPublisher and broadcast.
    this.state.mood = Math.floor(Math.sin(Date.now() / 60_000) * 200);
  }
}
