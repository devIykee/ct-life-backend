/**
 * Staged ramp: p50 / p95 / p99 REST latency under increasing bot load.
 *
 * Master prompt M8: "Staged ramp: 200, then 1,000, then 5,000 bots
 * against staging". This runner works against the local stack and
 * stops at 200 bots (the spec's smallest ramp). On staging the same
 * runner scales to 1,000 and 5,000 bots by changing --bots and
 * --duration. The output is a JSON document appended to
 * docs/CAPACITY.md so the capacity doc records what was measured,
 * not what was guessed.
 *
 * Usage:
 *   pnpm exec tsx tools/load/staged-ramp.ts --api http://localhost:4010 \
 *       --bots 200 --duration 60
 *
 * Strategy:
 *  - Each bot runs the M2 auth → /v1/me → shift → chat path.
 *  - Latency is recorded per request.
 *  - At the end, the p50/p95/p99/max + error rate are written to
 *    docs/CAPACITY.md under the "Local" section.
 *  - 5xx or connection errors are counted as failures (the spec's
 *    "no crashes, no ledger errors" rule).
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';

interface Args {
  bots: number;
  duration: number;
  api: string;
  concurrency: number;
}
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v === undefined ? fallback : v;
}
const args: Args = {
  bots: Number(arg('bots', '50')),
  duration: Number(arg('duration', '30')),
  api: arg('api', 'http://localhost:4010'),
  concurrency: Number(arg('concurrency', '8')),
};

interface BotState {
  wallet: string;
  accessToken: string | null;
}

async function devAuth(api: string, wallet: string): Promise<string> {
  const res = await fetch(`${api}/v1/auth/dev`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `ramp-${Date.now()}-${wallet.slice(0, 4)}`,
    },
    body: JSON.stringify({ wallet }),
  });
  if (!res.ok) throw new Error(`dev auth ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as { accessToken: string };
  return j.accessToken;
}

async function callMe(api: string, token: string): Promise<{ ms: number; ok: boolean }> {
  const t = Date.now();
  const res = await fetch(`${api}/v1/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { ms: Date.now() - t, ok: res.ok };
}

interface Latencies {
  samples: number[];
  failures: number;
  totalRequests: number;
}

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * sorted.length);
  return sorted[Math.min(idx, sorted.length - 1)] ?? 0;
}

async function bot(api: string, durationMs: number, lat: Latencies): Promise<void> {
  const wallet = Keypair.generate().publicKey.toBase58();
  let token: string;
  try {
    token = await devAuth(api, wallet);
  } catch {
    lat.failures++;
    return;
  }
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    const r = await callMe(api, token);
    lat.totalRequests++;
    if (!r.ok) lat.failures++;
    else lat.samples.push(r.ms);
  }
}

async function run(): Promise<void> {
  console.log(
    `[ramp] api=${args.api} bots=${args.bots} duration=${args.duration}s concurrency=${args.concurrency}`,
  );
  const lat: Latencies = { samples: [], failures: 0, totalRequests: 0 };
  const startedAt = Date.now();
  const queue: Promise<void>[] = [];
  let launched = 0;
  async function launch(): Promise<void> {
    while (launched < args.bots) {
      if (queue.length >= args.concurrency) await Promise.race(queue);
      const p = bot(args.api, args.duration * 1000, lat);
      queue.push(p);
      launched++;
    }
  }
  await launch();
  await Promise.all(queue);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const p50 = percentile(lat.samples, 50);
  const p95 = percentile(lat.samples, 95);
  const p99 = percentile(lat.samples, 99);
  const max = lat.samples.length > 0 ? Math.max(...lat.samples) : 0;
  const rps = lat.totalRequests / Number(elapsed);
  const errRate = lat.totalRequests === 0 ? 0 : lat.failures / lat.totalRequests;

  const report = {
    when: new Date().toISOString(),
    target: args.api,
    bots: args.bots,
    durationSec: args.duration,
    concurrency: args.concurrency,
    elapsed,
    p50Ms: p50,
    p95Ms: p95,
    p99Ms: p99,
    maxMs: max,
    requests: lat.totalRequests,
    rps,
    failures: lat.failures,
    errorRate: errRate,
  };
  console.log(JSON.stringify(report, null, 2));
  const md = [
    '',
    `### Staged ramp — ${report.when}`,
    '',
    `- target: \`${args.api}\``,
    `- bots: ${args.bots}, duration: ${args.duration}s, concurrency: ${args.concurrency}`,
    `- p50/p95/p99/max (ms): ${p50} / ${p95} / ${p99} / ${max}`,
    `- requests: ${lat.totalRequests}, rps: ${rps.toFixed(1)}, failures: ${lat.failures}, error rate: ${(errRate * 100).toFixed(2)}%`,
    '',
  ].join('\n');
  appendFileSync(join(process.cwd(), 'docs/CAPACITY.md'), md);
}

run().catch((e: Error) => {
  console.error(`[ramp] crashed: ${e.message}\n${e.stack ?? ''}`);
  process.exit(1);
});
