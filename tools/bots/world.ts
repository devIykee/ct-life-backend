/**
 * Bot world.
 *
 * Runs N bots in parallel against the dev API + realtime. Used by
 * the M2 e2e smoke and the M3 load test.
 *
 * Usage:
 *   pnpm tsx tools/bots/world.ts --bots 20 --venue timeline_square
 *
 * Defaults to 20 bots in timeline_square against localhost:4010/2567.
 */
import { Bot } from './bot.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v === undefined ? fallback : v;
}

async function main(): Promise<void> {
  const bots = Number(arg('bots', '20'));
  const venueId = arg('venue', 'timeline_square');
  const apiBase = arg('api', 'http://localhost:4010');
  const wsBase = arg('ws', 'ws://localhost:2567');
  const results = await Promise.allSettled(
    Array.from({ length: bots }, () => new Bot({ apiBase, wsBase, venueId }).run()),
  );
  let success = 0;
  let joined = 0;
  let rolled = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') {
      success++;
      if (r.value.joinedVenue) joined++;
      if (r.value.rolledLottery) rolled++;
    }
  }
  // eslint-disable-next-line no-console
  console.log(
    `[bots] ${success}/${bots} completed the full flow; ${joined} joined ${venueId}; ${rolled} rolled lottery`,
  );
}

void main();
