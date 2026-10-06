/**
 * Microbench: p50/p95 REST latency on /v1/me under bot load.
 *
 * Usage:
 *   pnpm tsx tools/scripts/microbench.ts --bots 50 --duration 60
 *
 * Spawns N concurrent bots that each loop GET /v1/me for
 * `duration` seconds, records the per-request latency, and
 * prints p50 / p95 / p99 / max + count.
 *
 * Assumes the API is reachable at --api (default
 * http://localhost:4010) with dev auth enabled.
 */
import { Keypair } from '@solana/web3.js';

interface Args {
  bots: number;
  duration: number;
  api: string;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v === undefined ? fallback : v;
}

function parseArgs(): Args {
  return {
    bots: Number(arg('bots', '50')),
    duration: Number(arg('duration', '60')),
    api: arg('api', 'http://localhost:4010'),
  };
}

interface Latency {
  readonly ms: number;
}

async function devAuth(api: string, wallet: string): Promise<string> {
  const res = await fetch(`${api}/v1/auth/dev`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wallet }),
  });
  if (!res.ok) throw new Error(`dev auth ${res.status}`);
  const j = (await res.json()) as { accessToken: string };
  return j.accessToken;
}

async function meOnce(api: string, token: string): Promise<number> {
  const t0 = Date.now();
  const res = await fetch(`${api}/v1/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`me ${res.status}`);
  // Drain the body so the connection closes.
  await res.text();
  return Date.now() - t0;
}

async function runBot(api: string, stopAt: number, sink: Latency[]): Promise<number> {
  const kp = Keypair.generate();
  const token = await devAuth(api, kp.publicKey.toBase58());
  let count = 0;
  while (Date.now() < stopAt) {
    try {
      const ms = await meOnce(api, token);
      sink.push({ ms });
      count++;
    } catch {
      // Ignore; the bench is about measuring happy-path latency.
    }
  }
  return count;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(Math.floor((p / 100) * sorted.length), sorted.length - 1);
  return sorted[idx]!;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const sink: Latency[] = [];
  const start = Date.now();
  const stopAt = start + args.duration * 1000;
  const settled = await Promise.allSettled(
    Array.from({ length: args.bots }, () => runBot(args.api, stopAt, sink)),
  );
  let totalReqs = 0;
  for (const r of settled) {
    if (r.status === 'fulfilled') totalReqs += r.value;
  }
  const elapsed = (Date.now() - start) / 1000;
  const values = sink.map((s) => s.ms);
  console.log(
    `[microbench] bots=${args.bots} duration=${args.duration}s reqs=${totalReqs} rps=${(totalReqs / elapsed).toFixed(1)}`,
  );
  console.log(
    `[microbench] p50=${percentile(values, 50)}ms p95=${percentile(values, 95)}ms p99=${percentile(values, 99)}ms max=${values.length === 0 ? 0 : Math.max(...values)}ms`,
  );
}

void main();
