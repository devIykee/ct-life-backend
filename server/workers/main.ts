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
 *   - Timeline NPC callers: a 5-minute tick lets each parody caller post a
 *     call on a house coin when their turn comes (see npc-callers.ts).
 *   - Analytics retention: a daily job (03:15 UTC) deletes product events
 *     older than ANALYTICS_RETENTION_DAYS (see analytics-prune.ts).
 *
 *   - Perp liquidation (every 5 s), alpha call grading (every 30 s), the
 *     payment poller (every 30 s, the top-up and ad payment backstop) and
 *     weekly rent (Monday 00:00 UTC). Prediction resolution (every 5 s) only
 *     with PREDICTIONS_SETTLEMENT_ENABLED=1. See liquidation.ts, alpha.ts,
 *     payment-poller.ts, rent.ts, predictions.ts.
 *
 * Multiple replicas: every repeatable job above is a BullMQ job scheduler,
 * so each tick is one job that one worker takes, whichever replica it runs
 * on. The handlers also hold row locks or conditional updates, so an
 * overlapping run (a slow tick, a stalled-job retry) never applies twice.
 * The in-process loops (market sim, police) run on every replica instead.
 *
 *   - Builder projects: weekly payroll (Monday 00:00 UTC), a daily risk roll
 *     and an hourly offer-expiry sweep, one queue (see projects.ts).
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
import { NPC_CALLERS_QUEUE, handleNpcCallers } from './npc-callers.js';
import { ACCOUNT_PURGE_QUEUE, handleAccountPurge } from './account-purge.js';
import { REKT_SWEEP_QUEUE, handleRektSweep } from './rekt-sweep.js';
import { LIQUIDATION_QUEUE, handleLiquidation } from './liquidation.js';
import { PREDICTIONS_QUEUE, handlePredictions } from './predictions.js';
import { ALPHA_GRADING_QUEUE, handleAlphaGrading } from './alpha.js';
import { PAYMENT_POLLER_QUEUE, handlePaymentPoller } from './payment-poller.js';
import { RENT_QUEUE, handleWeeklyRent } from './rent.js';
import { SHOP_DELIVERY_QUEUE, type ShopJobData } from '../application/shop-queue.js';
import { buildContext } from '../application/context.js';
import { startMarketSim } from './market-sim.js';
import { startPolice } from './police.js';
import { startLikenessScheduler } from './likeness.js';
import { buildLikenessRuntime } from '../application/likeness-runtime.js';
import type { LikenessGenerationWorker } from '../application/likeness-worker.js';
import type { LikenessPhotoService } from '../application/likeness-photos.js';
import { startProjectsWorker } from './projects.js';

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
  let likenessDelete: ((key: string) => Promise<void>) | undefined;
  if (!likeness) {
    const assembled = await buildLikenessRuntime(cfg, buildContext().db);
    if (assembled.storage) {
      const store = assembled.storage;
      likenessDelete = (key) => store.delete(key);
    }
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
  const callersQueue = new Queue(NPC_CALLERS_QUEUE, { connection: conn });
  const purgeQueue = new Queue(ACCOUNT_PURGE_QUEUE, { connection: conn });
  const rektQueue = new Queue(REKT_SWEEP_QUEUE, { connection: conn });
  const liquidationQueue = new Queue(LIQUIDATION_QUEUE, { connection: conn });
  const predictionsQueue = new Queue(PREDICTIONS_QUEUE, { connection: conn });
  const alphaQueue = new Queue(ALPHA_GRADING_QUEUE, { connection: conn });
  const paymentQueue = new Queue(PAYMENT_POLLER_QUEUE, { connection: conn });
  const rentQueue = new Queue(RENT_QUEUE, { connection: conn });

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

  const callersWorker = new Worker(NPC_CALLERS_QUEUE, async (job) => handleNpcCallers(job, ctx), {
    connection: newClient(redis),
  });
  callersWorker.on('failed', (job, err) =>
    log.error({ jobId: job?.id, err: err.message }, 'npc-callers failed'),
  );

  const purgeWorker = new Worker(
    ACCOUNT_PURGE_QUEUE,
    async (job) => handleAccountPurge(job, ctx, likenessDelete),
    { connection: newClient(redis) },
  );
  purgeWorker.on('failed', (job, err) =>
    log.error({ jobId: job?.id, err: err.message }, 'account-purge failed'),
  );

  const rektWorker = new Worker(REKT_SWEEP_QUEUE, async (job) => handleRektSweep(job, ctx), {
    connection: newClient(redis),
  });
  rektWorker.on('failed', (job, err) =>
    log.error({ jobId: job?.id, err: err.message }, 'rekt-sweep failed'),
  );

  const liquidationWorker = new Worker(
    LIQUIDATION_QUEUE,
    async (job) => handleLiquidation(job, ctx),
    { connection: newClient(redis) },
  );
  liquidationWorker.on('failed', (job, err) =>
    log.error({ jobId: job?.id, err: err.message }, 'liquidation failed'),
  );

  const predictionsWorker = new Worker(
    PREDICTIONS_QUEUE,
    async (job) => handlePredictions(job, ctx),
    { connection: newClient(redis) },
  );
  predictionsWorker.on('failed', (job, err) =>
    log.error({ jobId: job?.id, err: err.message }, 'predictions failed'),
  );

  const alphaWorker = new Worker(ALPHA_GRADING_QUEUE, async (job) => handleAlphaGrading(job, ctx), {
    connection: newClient(redis),
  });
  alphaWorker.on('failed', (job, err) =>
    log.error({ jobId: job?.id, err: err.message }, 'alpha-grading failed'),
  );

  const paymentWorker = new Worker(
    PAYMENT_POLLER_QUEUE,
    async (job) => handlePaymentPoller(job, ctx),
    { connection: newClient(redis) },
  );
  paymentWorker.on('failed', (job, err) =>
    log.error({ jobId: job?.id, err: err.message }, 'payment-poller failed'),
  );

  const rentWorker = new Worker(RENT_QUEUE, async (job) => handleWeeklyRent(job, ctx), {
    connection: newClient(redis),
  });
  rentWorker.on('failed', (job, err) =>
    log.error({ jobId: job?.id, err: err.message }, 'weekly-rent failed'),
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

  // Timeline NPC callers (each posts every 45-120 min; the job checks every 5).
  await callersQueue.upsertJobScheduler(
    'npc-callers',
    { pattern: '*/5 * * * *' },
    { name: 'tick', data: {} },
  );
  // DELETE /v1/me: erase queued files (likeness photos/models, ad creatives).
  await purgeQueue.upsertJobScheduler(
    'account-purge',
    { pattern: '*/5 * * * *' },
    { name: 'sweep', data: {} },
  );
  // Rekt Burger: close and pay clock-in shifts that ran to their maximum.
  await rektQueue.upsertJobScheduler(
    'rekt-sweep',
    { pattern: '* * * * *' },
    { name: 'sweep', data: {} },
  );

  // Sub-minute sweeps keep only recent job records, so Redis does not grow
  // by thousands of finished jobs a day.
  const sweepJobOpts = { removeOnComplete: 100, removeOnFail: 500 };
  // Perps: close positions whose coin price crossed the liquidation price.
  await liquidationQueue.upsertJobScheduler(
    'liquidation',
    { every: 5_000 },
    { name: 'sweep', data: {}, opts: sweepJobOpts },
  );
  // Prediction Pit: resolve bets whose closes_at has passed. Fails closed:
  // only with PREDICTIONS_SETTLEMENT_ENABLED=1, because the outcome resolver
  // is still a dev stub (application/predictions.ts). With the flag off, a
  // scheduler left by an earlier run is removed so nothing settles.
  if (cfg.features.predictionSettlement) {
    await predictionsQueue.upsertJobScheduler(
      'predictions',
      { every: 5_000 },
      { name: 'sweep', data: {}, opts: sweepJobOpts },
    );
  } else {
    await predictionsQueue.removeJobScheduler('predictions');
    log.info('prediction settlement off (PREDICTIONS_SETTLEMENT_ENABLED unset)');
  }
  // Alpha calls: grade hit target / hit stop / expired.
  await alphaQueue.upsertJobScheduler(
    'alpha-grading',
    { every: 30_000 },
    { name: 'sweep', data: {}, opts: sweepJobOpts },
  );
  // Top-up and ad payments not final at submit time; expire stale intents.
  await paymentQueue.upsertJobScheduler(
    'payment-poller',
    { every: 30_000 },
    { name: 'sweep', data: {}, opts: sweepJobOpts },
  );
  // Weekly rent: debit, or count a missed week (overdue, then evicted).
  await rentQueue.upsertJobScheduler(
    'weekly-rent',
    { pattern: '0 0 * * 1', tz: 'UTC' },
    { name: 'rent', data: {} },
  );

  // Builder projects: payroll, risk roll, offer expiry (one queue, three schedulers).
  const stopProjects = await startProjectsWorker(
    ctx,
    conn,
    newClient(redis),
    log.child({ worker: 'projects' }),
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
  void callersWorker;
  void purgeWorker;
  void purgeQueue;
  void rektWorker;
  void liquidationWorker;
  void predictionsWorker;
  void alphaWorker;
  void paymentWorker;
  void rentWorker;
  void crierQueue;
  void sundayQueue;
  void metaQueue;
  void districtQueue;
  void seasonQueue;
  void shopQueue;
  void pushQueue;
  void eventQueue;
  void casinoQueue;
  void callersQueue;
  void rektQueue;
  void log;

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
      await callersWorker.close();
      await purgeWorker.close();
      await rektWorker.close();
      await liquidationWorker.close();
      await predictionsWorker.close();
      await alphaWorker.close();
      await paymentWorker.close();
      await rentWorker.close();
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
      await callersQueue.close();
      await purgeQueue.close();
      await rektQueue.close();
      await liquidationQueue.close();
      await predictionsQueue.close();
      await alphaQueue.close();
      await paymentQueue.close();
      await rentQueue.close();
      await stopProjects();
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
