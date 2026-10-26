/**
 * Process health gauges in Prometheus text format: event-loop delay,
 * memory, and (when given) the Postgres pool.
 *
 * Event-loop delay comes from `perf_hooks.monitorEventLoopDelay`, a
 * histogram sampled by libuv. It is reset on every scrape, so each scrape
 * reports the window since the previous one. A p99 above ~100 ms means the
 * process is CPU-bound and every request and room patch waits behind it.
 * Pool `waiting` above zero for more than a moment means the pool is too
 * small for the load (or a query is slow).
 */
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

/** Sampling interval. The histogram records the timer's full period, so it is subtracted. */
const RESOLUTION_MS = 10;
let histogram: IntervalHistogram | null = null;

/** Start sampling the event loop (idempotent). */
export function startEventLoopMonitor(): void {
  if (histogram) return;
  histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  histogram.enable();
}

export interface PoolLike {
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
}

/**
 * Render the gauges and reset the event-loop window.
 * @param service - Label for the process (api, realtime).
 * @param pool - The pg pool, when the process has one.
 * @returns Prometheus text lines (with a trailing newline).
 */
export function renderProcessMetrics(service: string, pool?: PoolLike): string {
  startEventLoopMonitor();
  const h = histogram!;
  const ms = (ns: number): string =>
    Number.isFinite(ns) ? Math.max(0, ns / 1e6 - RESOLUTION_MS).toFixed(2) : '0';
  const mem = process.memoryUsage();
  const lines = [
    '# HELP ct_life_event_loop_delay_ms Event-loop delay since the last scrape',
    '# TYPE ct_life_event_loop_delay_ms gauge',
    `ct_life_event_loop_delay_ms{service="${service}",q="p50"} ${ms(h.percentile(50))}`,
    `ct_life_event_loop_delay_ms{service="${service}",q="p99"} ${ms(h.percentile(99))}`,
    `ct_life_event_loop_delay_ms{service="${service}",q="max"} ${ms(h.max)}`,
    '# HELP ct_life_memory_bytes Process memory',
    '# TYPE ct_life_memory_bytes gauge',
    `ct_life_memory_bytes{service="${service}",kind="rss"} ${mem.rss}`,
    `ct_life_memory_bytes{service="${service}",kind="heap_used"} ${mem.heapUsed}`,
  ];
  if (pool) {
    lines.push(
      '# HELP ct_life_pg_pool Postgres pool clients',
      '# TYPE ct_life_pg_pool gauge',
      `ct_life_pg_pool{service="${service}",state="total"} ${pool.totalCount}`,
      `ct_life_pg_pool{service="${service}",state="idle"} ${pool.idleCount}`,
      `ct_life_pg_pool{service="${service}",state="waiting"} ${pool.waitingCount}`,
    );
  }
  h.reset();
  return lines.join('\n') + '\n';
}
