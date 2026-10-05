/**
 * Realtime-vs-REALTIME.md cross-check.
 *
 * Reads `contract/realtime/messages.ts`, extracts the message-type names
 * (move, say, emote, etc.) and asserts that each one is documented in
 * `docs/REALTIME.md`. Missing entries fail the build.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const MESSAGES_PATH = join(REPO, 'contract/realtime/messages.ts');
const README_PATH = join(REPO, 'docs/REALTIME.md');

function camelToSnake(name: string): string {
  return name.replace(/([A-Z])/g, (_, ch) => `_${ch.toLowerCase()}`).replace(/^_/, '');
}

function extractMessageTypes(): string[] {
  const text = readFileSync(MESSAGES_PATH, 'utf8');
  // Match `export const <Name> = z.object` declarations.
  const re = /export const (\w+) = z\.object/g;
  // Use the snake_case form only; the docs and the realtime protocol use
  // snake_case names (e.g. `payment_confirmed`, `npc_tap`).
  const types = new Set<string>();
  for (const m of text.matchAll(re)) {
    const name = m[1];
    if (!name) continue;
    const stripped = name.replace(/Message$/, '');
    types.add(camelToSnake(stripped));
  }
  return [...types];
}

function main(): void {
  const types = extractMessageTypes();
  const md = readFileSync(README_PATH, 'utf8');
  const missing = types.filter((t) => !md.includes(`\`${t}\``));
  if (missing.length === 0) {
    console.log(`realtime-vs-readme: OK (${types.length} messages documented).`);
    process.exit(0);
  }

  console.log('realtime-vs-readme: not documented in docs/REALTIME.md:');
  for (const t of missing) console.log(`  - ${t}`);
  process.exit(1);
}

main();
