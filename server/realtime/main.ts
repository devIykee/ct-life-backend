/**
 * Realtime composition root.
 *
 * Boots a Colyseus Server with the city, market, and venue rooms.
 * The venue room is registered once; Colyseus creates a new
 * instance per call to `joinOrCreate("venue", { venueId, token })`
 * when the current cap is hit. The 20 s reconnection is
 * Colyseus-default.
 *
 * Redis presence + driver are loaded for multi-replica scaling in
 * M3. For M2 the server runs single-process.
 */
import { Server, RedisPresence, RedisDriver } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { createServer } from 'node:http';
import { loadConfig } from '../shared/config/config.js';
import { CityRoom } from './rooms/city.js';
import { MarketRoom } from './rooms/market.js';
import { VenueRoom } from './rooms/venue.js';
import { SpaceRoom } from './rooms/space.js';
import { VideoCallRoom } from './rooms/video-call.js';
import { HomeRoom } from './rooms/home.js';
import { createRedis } from '../shared/redis/client.js';

export interface RealtimeHandle {
  app: Server;
  start(): Promise<string>;
  stop(): Promise<void>;
}

/**
 *
 */
export async function buildRealtime(): Promise<RealtimeHandle> {
  const cfg = loadConfig();
  const redis = createRedis();
  const port = Number(process.env.PORT_REALTIME ?? cfg.port);
  const httpServer = createServer();
  // Health endpoint for the container HEALTHCHECK and the platform probe.
  // Only the health paths are answered here; every other request is left
  // untouched so Colyseus keeps serving its own matchmaking routes and the
  // WebSocket upgrade.
  httpServer.on('request', (req, res) => {
    if (req.url !== '/healthz' && req.url !== '/readyz') return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ts: Date.now() }));
  });
  const gameServer = new Server({
    transport: new WebSocketTransport({ server: httpServer }),
    driver: new RedisDriver(redis.main),
    presence: new RedisPresence(redis.main),
  });
  gameServer.define('city', CityRoom);
  gameServer.define('market', MarketRoom);
  gameServer.define('venue', VenueRoom).filterBy(['venueId']);
  gameServer.define('space', SpaceRoom, {
    maxClients: 50,
    filterBy: () => true, // every space is its own instance
  });
  // One room per home so a host and their guests share it.
  gameServer.define('home', HomeRoom).filterBy(['homeId']);
  gameServer.define('video_call', VideoCallRoom, {
    maxClients: 8,
    filterBy: () => true,
  });
  await gameServer.listen(port);
  return {
    app: gameServer,
    start: async () => `ws://0.0.0.0:${port}`,
    stop: async () => {
      await (gameServer as unknown as { shutdown: () => Promise<void> }).shutdown();
      await redis.close();
    },
  };
}

const isDirect =
  typeof process.argv[1] === 'string' && process.argv[1].endsWith('realtime/main.ts');
if (isDirect) {
  buildRealtime()
    .then(async (h) => {
      const url = await h.start();
      // eslint-disable-next-line no-console
      console.log(`[realtime] listening on ${url}`);
    })
    .catch((e: Error) => {
      console.error('[realtime] failed to start:', e);
      process.exit(1);
    });
  const shutdown = async (): Promise<void> => {
    const h = await buildRealtime();
    await h.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
