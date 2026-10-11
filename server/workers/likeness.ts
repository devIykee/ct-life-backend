/** Serial bounded scheduler for an explicitly assembled likeness runtime. No credentials/default enablement. */
import type { LikenessGenerationWorker } from '../application/likeness-worker.js';
import type { LikenessPhotoService } from '../application/likeness-photos.js';
export interface LikenessScheduler {
  stop(): Promise<void>;
}
/** Run one stage at a time; shutdown waits for the current bounded operation. */
export function startLikenessScheduler(
  worker: LikenessGenerationWorker,
  photos: LikenessPhotoService,
  onFailure: () => void,
  intervalMs = 1000,
): LikenessScheduler {
  let stopped = false,
    timer: ReturnType<typeof setTimeout> | undefined,
    running: Promise<void> = Promise.resolve(),
    lastCleanup = 0;
  const interval = Math.max(250, Math.min(30_000, intervalMs));
  const run = async () => {
    if (stopped) return;
    try {
      if (Date.now() - lastCleanup >= 60_000) {
        await photos.cleanup();
        await worker.cleanup();
        lastCleanup = Date.now();
      }
      await worker.tick();
    } catch {
      onFailure(); /* Log a stable event, never provider errors or private object URLs. */
    }
    if (!stopped) {
      timer = setTimeout(() => {
        running = run();
      }, interval);
      timer.unref();
    }
  };
  running = run();
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}
