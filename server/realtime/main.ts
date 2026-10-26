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
import { StreetRoom } from './rooms/street.js';
import { VehiclesRoom } from './rooms/vehicles.js';
import { createRedis } from '../shared/redis/client.js';
import { buildContext } from '../application/context.js';
import { renderProcessMetrics, startEventLoopMonitor } from '../shared/infra/process-metrics.js';

/**
 * Answer /healthz, /readyz and /metrics in front of Colyseus.
 *
 * Colyseus registers its own `request` listener for matchmaking. A second
 * listener that also answered the health paths made Colyseus write to an
 * already-sent response (ERR_HTTP_HEADERS_SENT on every probe), so the
 * Colyseus listeners are moved behind one dispatcher that answers the ops
 * paths itself and hands every other request to Colyseus untouched.
 * @param httpServer - The server Colyseus listens on (after listen()).
 * @param pool - The realtime process's Postgres pool, for the pool gauges.
 */
function answerOpsPaths(
  httpServer: ReturnType<typeof createServer>,
  pool: () => import('pg').Pool,
): void {
  startEventLoopMonitor();
  const colyseus = httpServer.listeners('request') as ((...a: unknown[]) => void)[];
  httpServer.removeAllListeners('request');
  httpServer.on('request', (req, res) => {
    if (req.url === '/healthz' || req.url === '/readyz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ts: Date.now() }));
      return;
    }
    if (req.url === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      res.end(renderProcessMetrics('realtime', pool()));
      return;
    }
    for (const l of colyseus) l.call(httpServer, req, res);
  });
}

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
  // One street room per district (instances overflow at 100 players).
  gameServer.define('street', StreetRoom).filterBy(['district']);
  // One island-wide room for vehicles; clients only receive nearby ones.
  gameServer.define('vehicles', VehiclesRoom);
  gameServer.define('video_call', VideoCallRoom, {
    maxClients: 8,
    filterBy: () => true,
  });
  await gameServer.listen(port);
  answerOpsPaths(httpServer, () => buildContext().db.pool);
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
