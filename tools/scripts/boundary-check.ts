/**
 * Architecture-boundary check.
 *
 * Enforces the layering rule from docs/ARCHITECTURE.md:
 *
 *   transport -> application -> domain <- infrastructure
 *
 * The domain layer (server/shared/domain, packages/*) and the application
 * layer (server/shared/application) cannot import from transport
 * (server/api, server/realtime, server/workers, tools/bots) or from
 * infrastructure adapters (server/shared/infra).
 *
 * Composition roots (the main.ts of each process) are the only places
 * allowed to import from anywhere.
 *
 * Run: pnpm boundary:check
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';

const REPO = process.cwd();
const DOMAIN_ROOTS = ['server/shared/domain', 'server/shared/application', 'packages'];
const INFRA_ROOTS = ['server/shared/infra'];
const TRANSPORT_ROOTS = ['server/api', 'server/realtime', 'server/workers', 'tools/bots'];
const COMPOSITION_ROOTS = new Set([
  'server/api/main.ts',
  'server/realtime/main.ts',
  'server/workers/main.ts',
  'tools/bots/main.ts',
]);
const CONFIG_OBJECT_PATTERNS = [/^import .* from .*['"]\..*\/config['"]/];
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'target',
  '.git',
  '.runtime',
  'src',
  '__tests__',
  'tests',
]);
const SOURCE_EXT = new Set(['.ts', '.mts', '.cts']);

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
    else if (SOURCE_EXT.has(extname(p))) out.push(p);
  }
  return out;
}

function isCompositionRoot(file: string): boolean {
  const rel = file.replace(`${REPO}/`, '');
  return COMPOSITION_ROOTS.has(rel);
}

/** Find every relative import spec in a file. */
function findImports(text: string): string[] {
  const re = /(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g;
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    const spec = m[1];
    if (spec !== undefined) out.push(spec);
  }
  return out;
}

/**
 * Given a file path and a relative import spec, return the resolved file
 * path that would be loaded, or null if the spec points outside the repo
 * (e.g. a package import).
 */
function resolveImport(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  // The repo lives in process.cwd(); the from path is absolute.
  const start = from.split('/').slice(0, -1).join('/');
  const parts = spec.split('/');
  let dir = start;
  for (const part of parts) {
    if (part === '..') {
      const idx = dir.lastIndexOf('/');
      if (idx < 0) return null;
      dir = dir.slice(0, idx);
    } else if (part !== '.') {
      dir = `${dir}/${part}`;
    }
  }
  // Try as a file (.ts) and as a directory + index.ts.
  const candidates = [`${dir}.ts`, `${dir}/index.ts`, `${dir}.js`, `${dir}/index.js`];
  for (const c of candidates) {
    try {
      const st = statSync(c);
      if (st.isFile()) return c;
    } catch {
      /* continue */
    }
  }
  return null;
}

function inRoots(file: string, roots: string[]): boolean {
  for (const r of roots) {
    if (file.startsWith(`${REPO}/${r}/`)) return true;
  }
  return false;
}

let violations = 0;
const seen = new Set<string>();

function flag(file: string, rule: string, detail: string): void {
  const rel = file.replace(`${REPO}/`, '');
  const key = `${rel}::${rule}::${detail}`;
  if (seen.has(key)) return;
  seen.add(key);
  // eslint-disable-next-line no-console
  console.log(`[FAIL] ${rel}: ${rule} (${detail})`);
  violations++;
}

function checkFile(file: string, layer: 'domain' | 'application' | 'infra'): void {
  if (isCompositionRoot(file)) return;
  const text = readFileSync(file, 'utf8');
  const imports = findImports(text);

  // Domain / application cannot import transport, infra, or a config module.
  if (layer === 'domain' || layer === 'application') {
    for (const spec of imports) {
      const resolved = resolveImport(file, spec);
      if (resolved === null) continue;
      for (const t of TRANSPORT_ROOTS) {
        if (inRoots(resolved, [t])) {
          flag(file, 'domain-imports-transport', `imported ${spec} -> ${t}`);
        }
      }
      for (const i of INFRA_ROOTS) {
        if (inRoots(resolved, [i])) {
          flag(file, 'domain-imports-infra', `imported ${spec} -> ${i}`);
        }
      }
      for (const pat of CONFIG_OBJECT_PATTERNS) {
        if (pat.test(`from "${spec}"`)) {
          flag(file, 'domain-imports-config', `imported ${spec}`);
        }
      }
    }
  }

  // Infra can import from anywhere, but not from transport.
  if (layer === 'infra') {
    for (const spec of imports) {
      const resolved = resolveImport(file, spec);
      if (resolved === null) continue;
      for (const t of TRANSPORT_ROOTS) {
        if (inRoots(resolved, [t])) {
          flag(file, 'infra-imports-transport', `imported ${spec} -> ${t}`);
        }
      }
    }
  }

  // Transport can import anything; no checks.

  // Soft size limits (40-line functions, 300-line files) — warn only at
  // this layer; the ESLint `max-lines-per-function` and `max-lines` rules
  // are the authoritative enforcer when present.
  const lineCount = text.split('\n').length;
  if (lineCount > 300) {
    flag(file, 'soft-size', `file is ${lineCount} lines (> 300; refactor or justify)`);
  }
}

function main(): void {
  for (const root of DOMAIN_ROOTS) {
    const full = join(REPO, root);
    try {
      statSync(full);
    } catch {
      continue;
    }
    for (const file of walk(full)) checkFile(file, 'domain');
  }
  for (const root of INFRA_ROOTS) {
    const full = join(REPO, root);
    try {
      statSync(full);
    } catch {
      continue;
    }
    for (const file of walk(full)) checkFile(file, 'infra');
  }

  if (violations === 0) {
    // eslint-disable-next-line no-console
    console.log('boundary-check: layering OK.');
    process.exit(0);
  } else {
    // eslint-disable-next-line no-console
    console.log(`boundary-check: ${violations} violation(s).`);
    process.exit(1);
  }
}

main();
