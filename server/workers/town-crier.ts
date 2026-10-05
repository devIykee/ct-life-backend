/**
 * Town Crier worker.
 *
 * Subscribes to the `events:publish` queue. M2 ships a stub that
 * logs each event. M3 fans the event out to the city room's NPC
 * brains and broadcasts to the clients.
 */
import type { Job } from 'bullmq';
import { createLogger } from '../shared/logger/logger.js';
import type { RedisLayer } from '../shared/redis/client.js';

/**
 *
 */
export async function handleTownCrier(
  job: Job<{ event: unknown }>,
  _redis: RedisLayer,
): Promise<void> {
  const log = createLogger().child({ worker: 'town-crier' });
  log.info({ jobId: job.id, event: job.data.event }, 'town crier event');
}
