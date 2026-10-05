/**
 * Verify layering: domain layer (server/shared, packages/...) MUST NOT import
 * from transport (server/api, server/realtime, server/workers) or from
 * infrastructure adapters outside of the composition roots.
 *
 * Composition roots (the main.ts entry of each process) are allowed to
 * import anything.
 *
 * Run: pnpm boundary:check
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';

const DOMAIN_ROOTS = ['server/shared', 'packages'];
const TRANSPORT_ROOTS = ['server/api', 'server/realtime', 'server/workers', 'tools/bots'];
const COMPOSITION_ROOTS = new Set([
  'server/api/main.ts',
  'server/realtime/main.ts',
  'server/workers/main.ts',
  'tools/bots/main.ts',
]);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'target', '.git', 'src']);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (extname(p) === '.ts') out.push(p);
  }
  return out;
}

function isCompositionRoot(file: string): boolean {
  return COMPOSITION_ROOTS.has(file.replace(/^.\//, ''));
}

function importsFromTransport(text: string): string[] {
  const violations: string[] = [];
  const re = /(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g;
  for (const m of text.matchAll(re)) {
    const spec: string | undefined = m[1];
    if (spec === undefined || !spec.startsWith('.')) continue;
    // Resolve relative path: walk up to find a matching file under a known root.
    // We use a simple substring check: if the resolved spec contains a transport
    // root, that's a violation. The composition root check below exempts the
    // entry points.
    const safeSpec: string = spec;
    for (const t of TRANSPORT_ROOTS) {
      if (safeSpec.includes(`/../${t}/`) || safeSpec.includes(`/${t}/`)) {
        violations.push(t);
      }
    }
  }
  return violations;
}

let failed = 0;
for (const d of DOMAIN_ROOTS) {
  for (const file of walk(join(process.cwd(), d))) {
    if (isCompositionRoot(file)) continue;
    const text = readFileSync(file, 'utf8');
    const hits = importsFromTransport(text);
    if (hits.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[FAIL] ${file}: domain layer imports transport (${hits.join(', ')})`);
      failed++;
    }
  }
}

if (failed === 0) {
  // eslint-disable-next-line no-console
  console.log('boundary-check: layering OK.');
  process.exit(0);
} else {
  // eslint-disable-next-line no-console
  console.log(`boundary-check: ${failed} violation(s).`);
  process.exit(1);
}
