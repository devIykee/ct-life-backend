/**
 * Contract cross-checks.
 *
 * Reads `contract/ids/errors.json` and asserts that every code is
 * referenced from at least one of:
 *   1. `contract/openapi.yaml` (REST API responses)
 *   2. `contract/realtime/messages.ts` (realtime `RejectedMessage` enum)
 *
 * Realtime codes (those that come back as `rejected` messages on the
 * Colyseus side) do not need a corresponding REST example.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const ERRORS_PATH = join(REPO, 'contract/ids/errors.json');
const OPENAPI_PATH = join(REPO, 'contract/openapi.yaml');
const MESSAGES_PATH = join(REPO, 'contract/realtime/messages.ts');

interface ErrorEntry {
  code: string;
  httpStatus: number;
  message: string;
}

function main(): void {
  const errors = JSON.parse(readFileSync(ERRORS_PATH, 'utf8')) as { codes: ErrorEntry[] };
  const openapi = readFileSync(OPENAPI_PATH, 'utf8');
  const messages = readFileSync(MESSAGES_PATH, 'utf8');

  const missing: string[] = [];
  for (const e of errors.codes) {
    const inOpenapi = new RegExp(`code:\\s*"?${e.code}"?`).test(openapi);
    // Real-time: appear inside the `z.enum([...])` list of RejectedMessage.
    const inRealtime = new RegExp(`['"]${e.code}['"]`).test(messages);
    if (!inOpenapi && !inRealtime) {
      missing.push(e.code);
    }
  }

  if (missing.length === 0) {
    console.log(
      `openapi-vs-errors: OK (every code in errors.json is referenced in openapi.yaml or contract/realtime/messages.ts).`,
    );
    process.exit(0);
  }

  console.log('openapi-vs-errors: not referenced anywhere:');
  for (const c of missing) console.log(`  - ${c}`);
  process.exit(1);
}

main();
