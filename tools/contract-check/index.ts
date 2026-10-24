/**
 * Contract-check entry point.
 *
 * Runs every check in sequence:
 *   1. schema-validate — every JSON in contract/ids and contract/config
 *      against its companion schema.
 *   2. openapi-vs-errors — every code in errors.json is referenced in
 *      openapi.yaml.
 *   3. realtime-vs-readme — every message type in contract/realtime is
 *      documented in docs/REALTIME.md.
 *   4. casino-rtp — the casino paytable's computed RTP is 94-96% and matches
 *      the figure in casino.json.
 *   5. openapi-docs — render openapi.yaml to static HTML.
 *
 * Run: pnpm contract:check
 */
import { spawnSync } from 'node:child_process';

const REPO = process.cwd();

const STEPS: Array<{ name: string; cmd: string; args: string[] }> = [
  { name: 'schema-validate', cmd: 'tsx', args: ['tools/contract-check/schema-validate.ts'] },
  { name: 'openapi-vs-errors', cmd: 'tsx', args: ['tools/contract-check/openapi-vs-errors.ts'] },
  { name: 'realtime-vs-readme', cmd: 'tsx', args: ['tools/contract-check/realtime-vs-readme.ts'] },
  { name: 'casino-rtp', cmd: 'tsx', args: ['tools/contract-check/casino-rtp.ts'] },
  { name: 'openapi-docs', cmd: 'tsx', args: ['tools/contract-check/openapi-docs.ts'] },
];

let failed = 0;
for (const step of STEPS) {
  console.log(`\n=== ${step.name} ===`);
  const r = spawnSync(step.cmd, step.args, { cwd: REPO, stdio: 'inherit' });
  if (r.status !== 0) failed++;
}

if (failed > 0) {
  console.log(`\ncontract-check: ${failed} step(s) failed.`);
  process.exit(1);
}

console.log(`\ncontract-check: all steps green.`);
