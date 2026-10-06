/**
 * Workers composition root.
 *
 * M2 ships three BullMQ workers:
 *
 *   - Town Crier: M2 subscribes to a stub `events:publish` queue; M3
 *     wires the real event engine. The worker logs each event so the
 *     M2 smoke confirms the wiring. In M3 the worker fans out to the
 *     city room's NPC brains.
 *
 *   - Daily board refresh: once per hour the worker recomputes the
 *     weekly_pnl and net_worth ZSETs in Redis from the ledger.
 *     M2 ships a stub that touches a counter.
 *
 *   - Sunday Unlock / Weekly Meta: placeholders for M5. They are
 *     registered as repeatable jobs so the cron expression is fixed
 *     and only the handler changes.
 *
 * The workers process does not open a public HTTP port by default
 * (PORT_WORKERS=0). A `/healthz` handler is registered on the
 * configured `PORT_WORKERS` if non-zero.
 */
import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import { createServer } from 'node:http';
import IORedis from 'ioredis';
import { loadConfig } from '../shared/config/config.js';
import { createRedis } from '../shared/redis/client.js';
import { createLogger } from '../shared/logger/logger.js';
import { handleDailyBoardRefresh } from './daily-board.js';
import { handleTownCrier } from './town-crier.js';
import { handleSundayUnlock, handleWeeklyMeta } from './sunday-unlock.js';
import { handleDistrictRollover } from './district-rollover.js';
import { buildContext } from '../application/context.js';

export interface WorkersHandle {
  redis: ReturnType<typeof createRedis>;
  shutdown(): Promise<void>;
  /** Healthz HTTP server; null if PORT_WORKERS is 0. */
  healthzServer: ReturnType<typeof createServer> | null;
}

function redisConnection(redis: ReturnType<typeof createRedis>): ConnectionOptions {
  // BullMQ wants a connection options object; we share the same
  // ioredis instance via a separate client so BullMQ's blocking
  // commands don't interfere with the rest of the app.
  return {
    host: new URL(redis.main.options.host ?? 'redis://localhost:6379').hostname,
    port: Number(new URL(redis.main.options.host ?? 'redis://localhost:6379').port || 6379),
    password: redis.main.options.password,
    maxRetriesPerRequest: null,
  };
}

function newClient(redis: ReturnType<typeof createRedis>): IORedis {
  return new IORedis({
    host: new URL(redis.main.options.host ?? 'redis://localhost:6379').hostname,
    port: Number(new URL(redis.main.options.host ?? 'redis://localhost:6379').port || 6379),
    password: redis.main.options.password,
    maxRetriesPerRequest: null,
  });
}

/**
 *
 */
export async function buildWorkers(): Promise<WorkersHandle> {
  const cfg = loadConfig();
  const redis = createRedis();
  const log = createLogger().child({ mod: 'workers' });
  const conn = redisConnection(redis);

  // Queues.
  const crierQueue = new Queue<{ event: unknown }>('events:publish', { connection: conn });
  const dailyQueue = new Queue('jobs:daily-board', { connection: conn });
  const sundayQueue = new Queue('jobs:sunday-unlock', { connection: conn });
  const metaQueue = new Queue('jobs:weekly-meta', { connection: conn });
  const districtQueue = new Queue('jobs:district-rollover', { connection: conn });

  // Workers.
  const crierWorker = new Worker<{ event: unknown }>(
    'events:publish',
    async (job: Job<{ event: unknown }>) => handleTownCrier(job, redis),
    { connection: newClient(redis) },
  );
  crierWorker.on('failed', (job, err) =>
    log.error({ jobId: job?.id, err: err.message }, 'crier failed'),
  );

  const dailyWorker = new Worker(
    'jobs:daily-board',
    async (job) => handleDailyBoardRefresh(job, redis),
    { connection: newClient(redis) },
  );
  dailyWorker.on('failed', (job, err) =>
    log.error({ jobId: job?.id, err: err.message }, 'daily-board failed'),
  );

  const sundayWorker = new Worker(
    'jobs:sunday-unlock',
    async (job) => handleSundayUnlock(job, redis),
    { connection: newClient(redis) },
  );
  sundayWorker.on('failed', (job, err) =>
    log.error({ jobId: job?.id, err: err.message }, 'sunday-unlock failed'),
  );

  const metaWorker = new Worker('jobs:weekly-meta', async (job) => handleWeeklyMeta(job, redis), {
    connection: newClient(redis),
  });
  metaWorker.on('failed', (job, err) =>
    log.error({ jobId: job?.id, err: err.message }, 'weekly-meta failed'),
  );

  const ctx = buildContext();
  const districtWorker = new Worker(
    'jobs:district-rollover',
    async (job) => handleDistrictRollover(job, ctx),
    { connection: newClient(redis) },
  );
  districtWorker.on('failed', (job, err) =>
    log.error({ jobId: job?.id, err: err.message }, 'district-rollover failed'),
  );

  // Repeatable jobs via the modern upsertJobScheduler API. The cron
  // strings are placeholders; the actual schedule is M5.
  await dailyQueue.upsertJobScheduler(
    'daily-board-refresh',
    { pattern: '0 * * * *' },
    { name: 'refresh', data: {} },
  );
  await sundayQueue.upsertJobScheduler(
    'sunday-unlock',
    { pattern: '0 20 * * 0' },
    { name: 'unlock', data: {} },
  );
  await metaQueue.upsertJobScheduler(
    'weekly-meta',
    { pattern: '5 20 * * 0' },
    { name: 'meta', data: {} },
  );
  await districtQueue.upsertJobScheduler(
    'district-rollover',
    { pattern: '5 0 * * *' },
    { name: 'rollover', data: {} },
  );

  // Optional healthz HTTP server.
  let healthzServer: ReturnType<typeof createServer> | null = null;
  const port = Number(process.env.PORT_WORKERS ?? 0);
  if (port > 0) {
    healthzServer = createServer((req, res) => {
      if (req.url === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ts: Date.now() }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => healthzServer!.listen(port, () => resolve()));
    log.info({ port }, 'workers healthz listening');
  }

  // Hold refs to keep them alive.
  void crierWorker;
  void dailyWorker;
  void sundayWorker;
  void metaWorker;
  void districtWorker;
  void crierQueue;
  void sundayQueue;
  void metaQueue;
  void districtQueue;
  void log;
  void cfg;

  return {
    redis,
    healthzServer,
    async shutdown() {
      await crierWorker.close();
      await dailyWorker.close();
      await sundayWorker.close();
      await metaWorker.close();
      await districtWorker.close();
      await crierQueue.close();
      await dailyQueue.close();
      await sundayQueue.close();
      await metaQueue.close();
      await districtQueue.close();
      if (healthzServer) await new Promise<void>((r) => healthzServer!.close(() => r()));
      await redis.close();
    },
  };
}

const isDirect = typeof process.argv[1] === 'string' && process.argv[1].endsWith('workers/main.ts');
if (isDirect) {
  buildWorkers()
    .then(async (h) => {
      const log = createLogger().child({ mod: 'workers' });
      log.info('workers running');
      const shutdown = async (): Promise<void> => {
        await h.shutdown();
        process.exit(0);
      };
      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());
    })
    .catch((e: Error) => {
      console.error('[workers] failed to start:', e);
      process.exit(1);
    });
}
