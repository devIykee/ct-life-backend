/**
 * Poll the /metrics endpoints of the API and realtime processes during a
 * load run and report the worst values seen: event-loop delay, Postgres
 * pool waiters, and memory. Stops after --duration seconds (or Ctrl-C).
 *
 *   pnpm exec tsx tools/load/sample-metrics.ts \
 *     --urls http://localhost:4010/metrics,http://localhost:2567/metrics \
 *     --every 5 --duration 900 --out /tmp/metrics.json
 */
import { writeFileSync } from 'node:fs';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i < 0 ? undefined : process.argv[i + 1];
  return v === undefined ? fallback : v;
}

const URLS = arg('urls', 'http://localhost:4010/metrics,http://localhost:2567/metrics').split(',');
const EVERY_S = Number(arg('every', '5'));
const DURATION_S = Number(arg('duration', '900'));
const OUT = arg('out', '');

interface Series {
  max: number;
  sum: number;
  n: number;
}
const series = new Map<string, Series>();

function note(key: string, v: number): void {
  const s = series.get(key) ?? { max: -Infinity, sum: 0, n: 0 };
  s.max = Math.max(s.max, v);
  s.sum += v;
  s.n += 1;
  series.set(key, s);
}

const LINE = /^(ct_life_(?:event_loop_delay_ms|memory_bytes|pg_pool))\{([^}]*)\} ([0-9.eE+-]+)$/;

async function scrape(url: string): Promise<void> {
  try {
    const text = await (await fetch(url)).text();
    for (const line of text.split('\n')) {
      const m = LINE.exec(line);
      if (!m) continue;
      const labels = m[2]!.replace(/"/g, '').replace(/,/g, ' ');
      const v = Number(m[3]);
      note(`${m[1]} ${labels}`, m[1] === 'ct_life_memory_bytes' ? v / 1048576 : v);
    }
  } catch {
    note(`scrape_errors ${url}`, 1);
  }
}

function report(): void {
  const out: Record<string, { max: number; avg: number }> = {};
  for (const [k, s] of [...series.entries()].sort()) {
    out[k.replace('ct_life_memory_bytes', 'ct_life_memory_mb')] = {
      max: Math.round(s.max * 100) / 100,
      avg: Math.round((s.sum / s.n) * 100) / 100,
    };
  }
  console.info(JSON.stringify(out, null, 2));
  if (OUT) writeFileSync(OUT, JSON.stringify(out, null, 2));
}

const stopAt = Date.now() + DURATION_S * 1000;
process.on('SIGINT', () => {
  report();
  process.exit(0);
});
while (Date.now() < stopAt) {
  await Promise.all(URLS.map(scrape));
  await new Promise((r) => setTimeout(r, EVERY_S * 1000));
}
report();
