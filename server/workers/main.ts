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
 *   - Rug Room sweep: a per-minute job refunds expired head-to-head
 *     challenges and closes abandoned crash rounds (see casino-sweep.ts).
 *   - Duo Shop delivery: delayed `out` and `deliver` jobs per order, plus a
 *     per-minute sweep (see shop-delivery.ts).
 *
 *   - Push: a 5-minute sweep for the streak-ending and daily-clue pushes (push.ts).
 *   - Event announcer: a per-minute sweep that broadcasts `event_live` and
 *     `event_ended` for real events (see event-announce.ts).
 *
 *   - Police referee: starts and judges police pursuits and releases jail stays
 *     every 2 s (see police.ts).
 *
 *   - Market sim: ticks every live coin and launches house coins on
 *     market.json `launchIntervalSec` (see market-sim.ts).
 *
 *   - Analytics retention: a daily job (03:15 UTC) deletes product events
 *     older than ANALYTICS_RETENTION_DAYS (see analytics-prune.ts).
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
import { handleSeasonRollover } from './season-rollover.js';
import { handleShopDelivery } from './shop-delivery.js';
import { handlePush, PUSH_QUEUE } from './push.js';
import { EVENT_ANNOUNCE_QUEUE, handleEventAnnounce } from './event-announce.js';
import { CASINO_SWEEP_QUEUE, handleCasinoSweep } from './casino-sweep.js';
import { ANALYTICS_PRUNE_QUEUE, handleAnalyticsPrune } from './analytics-prune.js';
import { SHOP_DELIVERY_QUEUE, type ShopJobData } from '../application/shop-queue.js';
import { buildContext } from '../application/context.js';
import { startMarketSim } from './market-sim.js';
import { startPolice } from './police.js';
import { startLikenessScheduler } from './likeness.js';
import { buildLikenessRuntime } from '../application/likeness-runtime.js';
import type { LikenessGenerationWorker } from '../application/likeness-worker.js';
import type { LikenessPhotoService } from '../application/likeness-photos.js';

export interface WorkersHandle {
  redis: ReturnType<typeof createRedis>;
  shutdown(): Promise<void>;
  /** Healthz HTTP server; null if PORT_WORKERS is 0. */
  healthzServer: ReturnType<typeof createServer> | null;
}

function redisConnection(redis: ReturnType<typeof createRedis>): ConnectionOptions {
  // B12 fix: Build connection from redisUrl, not from bare host
  const cfg = loadConfig();
  const url = new URL(cfg.redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    password: url.password || redis.main.options.password,
    db: Number(url.pathname.slice(1) || 0),
    maxRetriesPerRequest: null,
  };
}

function newClient(redis: ReturnType<typeof createRedis>): IORedis {
  const cfg = loadConfig();
  const url = new URL(cfg.redisUrl);
  return new IORedis({
    host: url.hostname,
    port: Number(url.port || 6379),
    password: url.password || redis.main.options.password,
    db: Number(url.pathname.slice(1) || 0),
    maxRetriesPerRequest: null,
  });
}

/**
 *
 */
export async function buildWorkers(likeness?: {
  worker: LikenessGenerationWorker;
  photos: LikenessPhotoService;
}): Promise<WorkersHandle> {
  const cfg = loadConfig();
  const redis = createRedis();
  const log = createLogger().child({ mod: 'workers' });
  const conn = redisConnection(redis);
  if (!likeness) {
    const assembled = await buildLikenessRuntime(cfg, buildContext().db);
    if (assembled.worker && assembled.photos)
      likeness = { worker: assembled.worker, photos: assembled.photos };
  }
  // Cleanup remains active with configured private storage even when new generation is off.
  const likenessScheduler = likeness
    ? startLikenessScheduler(likeness.worker, likeness.photos, () =>
        log.error('likeness bounded sweep failed'),
      )
    : undefined;

  // Queues.
  // B12 fix: Queue names without colons (BullMQ rejects ":")
  const crierQueue = new Queue<{ event: unknown }>('events-publish', { connection: conn });
  const dailyQueue = new Queue('jobs-daily-board', { connection: conn });
  const sundayQueue = new Queue('jobs-sunday-unlock', { connection: conn });
  const metaQueue = new Queue('jobs-weekly-meta', { connection: conn });
  const districtQueue = new Queue('jobs-district-rollover', { connection: conn });
  const seasonQueue = new Queue('jobs-season-rollover', { connection: conn });
  const shopQueue = new Queue<ShopJobData>(SHOP_DELIVERY_QUEUE, { connection: conn });
  const pushQueue = new Queue(PUSH_QUEUE, { connection: conn });
  const eventQueue = new Queue(EVENT_ANNOUNCE_QUEUE, { connection: conn });
  const casinoQueue = new Queue(CASINO_SWEEP_QUEUE, { connection: conn });
  const analyticsQueue = new Queue(ANALYTICS_PRUNE_QUEUE, { connection: conn });

  // Workers.
  const crierWorker = new Worker<{ event: unknown }>(
    'events-publish',
    async (job: Job<{ event: unknown }>) => handleTownCrier(job, redis),
    { connection: newClient(redis) },
  );
  crierWorker.on('failed', (job, err) =>
    log.error({ jobId: job?.id, err: err.message }, 'crier failed'),
  );

  const dailyWorker = new Worker(
    'jobs-daily-board',
    async (job) => handleDailyBoardRefresh(job, redis),
    { connection: newClient(redis) },
  );
  dailyWorker.on('failed', (job, err) =>
    log.error({ jobId: job?.id, err: err.message }, 'daily-board failed'),
  );

  const sundayWorker = new Worker(
    'jobs-sunday-unlock',
    async (job) => handleSundayUnlock(job, redis),
    { connection: newClient(redis) },
  );
  sundayWorker.on('failed', (job, err) =>
    log.error({ jobId: job?.id, err: err.message }, 'sunday-unlock failed'),
  );

  const metaWorker = new Worker('jobs-weekly-meta', async (job) => handleWeeklyMeta(job, redis), {
    connection: newClient(redis),
  });
  metaWorker.on('failed', (job, err) =>
    log.error({ jobId: job?.id, err: err.message }, 'weekly-meta failed'),
  );

  const ctx = buildContext();
  const districtWorker = new Worker(
    'jobs-district-rollover',
    async (job) => handleDistrictRollover(job, ctx),
    { connection: newClient(redis) },
  );
  districtWorker.on('failed', (job, err) =>
    log.error({ jobId: job?.id, err: err.message }, 'district-rollover failed'),
  );

  const seasonWorker = new Worker(
    'jobs-season-rollover',
    async (job) => handleSeasonRollover(job, ctx),
    { connection: newClient(redis) },
  );
  seasonWorker.on('failed', (job, err) =>
    log.error({ jobId: job?.id, err: err.message }, 'season-rollover failed'),
  );

  const shopWorker = new Worker<ShopJobData>(
    SHOP_DELIVERY_QUEUE,
    async (job) => handleShopDelivery(job, ctx),
    { connection: newClient(redis) },
  );
  shopWorker.on('failed', (job, err) =>
    log.error({ jobId: job?.id, err: err.message }, 'shop-delivery failed'),
  );

  const pushWorker = new Worker(PUSH_QUEUE, async (job) => handlePush(job, ctx), {
    connection: newClient(redis),
  });
  pushWorker.on('failed', (job, err) =>
    log.error({ jobId: job?.id, err: err.message }, 'push failed'),
  );

  const eventWorker = new Worker(
    EVENT_ANNOUNCE_QUEUE,
    async (job) => handleEventAnnounce(job, ctx),
    {
      connection: newClient(redis),
    },
  );
  eventWorker.on('failed', (job, err) =>
    log.error({ jobId: job?.id, err: err.message }, 'event-announce failed'),
  );

  const casinoWorker = new Worker(CASINO_SWEEP_QUEUE, async (job) => handleCasinoSweep(job, ctx), {
    connection: newClient(redis),
  });
  casinoWorker.on('failed', (job, err) =>
    log.error({ jobId: job?.id, err: err.message }, 'casino-sweep failed'),
  );

  const analyticsWorker = new Worker(
    ANALYTICS_PRUNE_QUEUE,
    async (job) => handleAnalyticsPrune(job, ctx),
    { connection: newClient(redis) },
  );
  analyticsWorker.on('failed', (job, err) =>
    log.error({ jobId: job?.id, err: err.message }, 'analytics-prune failed'),
  );

  const stopMarket = await startMarketSim(ctx, log.child({ worker: 'market' }));
  const stopPolice = startPolice(ctx, log.child({ worker: 'police' }));

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
  await seasonQueue.upsertJobScheduler(
    'season-rollover',
    { pattern: '0 0 * * 1' },
    { name: 'rollover', data: {} },
  );
  // Safety net for Duo Shop orders whose delayed job was lost.
  await shopQueue.upsertJobScheduler(
    'shop-delivery-sweep',
    { pattern: '* * * * *' },
    { name: 'sweep', data: {} },
  );

  // Streak-ending and daily-clue pushes (no-ops without FCM credentials).
  await pushQueue.upsertJobScheduler(
    'push-sweep',
    { pattern: '*/5 * * * *' },
    { name: 'sweep', data: {} },
  );
  // Real events: announce start and end to the city.
  await eventQueue.upsertJobScheduler(
    'event-announce',
    { pattern: '* * * * *' },
    { name: 'sweep', data: {} },
  );
  // Rug Room: refund expired head-to-head challenges, close dead crash rounds.
  await casinoQueue.upsertJobScheduler(
    'casino-sweep',
    { pattern: '* * * * *' },
    { name: 'sweep', data: {} },
  );

  // Analytics retention (ANALYTICS_RETENTION_DAYS).
  await analyticsQueue.upsertJobScheduler(
    'analytics-prune',
    { pattern: '15 3 * * *' },
    { name: 'prune', data: {} },
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
  void seasonWorker;
  void shopWorker;
  void pushWorker;
  void eventWorker;
  void casinoWorker;
  void analyticsWorker;
  void crierQueue;
  void sundayQueue;
  void metaQueue;
  void districtQueue;
  void seasonQueue;
  void shopQueue;
  void pushQueue;
  void eventQueue;
  void casinoQueue;
  void analyticsQueue;
  void log;
  void cfg;

  return {
    redis,
    healthzServer,
    async shutdown() {
      stopMarket();
      stopPolice();
      await likenessScheduler?.stop();
      await crierWorker.close();
      await dailyWorker.close();
      await sundayWorker.close();
      await metaWorker.close();
      await districtWorker.close();
      await seasonWorker.close();
      await shopWorker.close();
      await pushWorker.close();
      await eventWorker.close();
      await casinoWorker.close();
      await analyticsWorker.close();
      await crierQueue.close();
      await dailyQueue.close();
      await sundayQueue.close();
      await metaQueue.close();
      await districtQueue.close();
      await seasonQueue.close();
      await shopQueue.close();
      await pushQueue.close();
      await eventQueue.close();
      await casinoQueue.close();
      await analyticsQueue.close();
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
