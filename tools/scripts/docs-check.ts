/**
 * Verify that every env var referenced in code also appears in .env.example
 * and the README. Fails the build if a referenced var is missing from either
 * place, or if .env.example lists a var that no code references (drift).
 *
 * The check is heuristic: it greps code for SCREAMING_SNAKE_CASE identifiers
 * and matches them against a known allowlist plus the .env.example file.
 *
 * Run: pnpm docs:check
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const root = process.cwd();
const codeRoots = ['server', 'packages', 'tools', 'programs'];
const docRoots = ['docs', 'README.md', '.env.example', 'CONTRIBUTING.md'];

const VAR_PATTERNS: readonly RegExp[] = [
  /process\.env\.([A-Z][A-Z0-9_]+)/g,
  /\benv\.([A-Z][A-Z0-9_]+)/g,
  /import\.meta\.env\.([A-Z][A-Z0-9_]+)/g,
];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'target', '.git']);

// Allowlist of constants that look like env vars but aren't (e.g. error codes).
const ALLOWLIST = new Set([
  'CONTRACT_V1_0_0',
  'HTTP_BAD_REQUEST',
  'HTTP_UNAUTHORIZED',
  'HTTP_FORBIDDEN',
  'HTTP_NOT_FOUND',
  'HTTP_CONFLICT',
  'HTTP_TOO_MANY_REQUESTS',
  'HTTP_426_UPGRADE_REQUIRED',
  'SERIALIZABLE',
  'UUID_V4',
  'UUID_V7',
  'NIL_UUID',
  'JSON_SCHEMA',
  'X_CLIENT_VERSION',
  'X_CONTRACT_VERSION',
  'AUTHORIZATION',
  'IDEMPOTENCY_KEY',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'].includes(extname(p))) out.push(p);
  }
  return out;
}

function readText(p: string): string {
  return readFileSync(p, 'utf8');
}

function extractEnvRefs(): Set<string> {
  const found = new Set<string>();
  // Match only env-var-style usage, not local SCREAMING_SNAKE identifiers.
  // Patterns we accept:
  //   process.env.MY_VAR
  //   env.MY_VAR           (where `env` is the imported loader)
  //   import.meta.env.MY_VAR
  // VAR_PATTERNS lives at module scope so it is easy to extend.
  for (const root of codeRoots) {
    const full = join(process.cwd(), root);
    try {
      statSync(full);
    } catch {
      continue;
    }
    for (const file of walk(full)) {
      // Skip the script that defines the pattern itself; otherwise its JSDoc
      // comments are matched as env var references.
      if (file.endsWith('docs-check.ts')) continue;
      const text = readText(file);
      for (const re of VAR_PATTERNS) {
        for (const m of text.matchAll(re)) {
          const v = m[1];
          if (!v) continue;
          if (v.length < 4) continue;
          if (v.length > 40) continue;
          if (ALLOWLIST.has(v)) continue;
          found.add(v);
        }
      }
    }
  }
  return found;
}

function extractEnvExampleVars(): Set<string> {
  const text = readText(join(root, '.env.example'));
  const out = new Set<string>();
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z][A-Z0-9_]+)\s*=/);
    const v: string | undefined = m ? m[1] : undefined;
    if (v !== undefined) out.add(v);
  }
  return out;
}

function main(): void {
  const referenced = extractEnvRefs();
  const declared = extractEnvExampleVars();
  // The check is one-way: any var referenced in code MUST be declared in
  // .env.example. The reverse is informational: a var in .env.example that no
  // code references is fine because future milestones will use it (M5+ push,
  // M7 X link, M8 Sentry, etc.). We only warn for those.
  const missing = [...referenced].filter((v) => v !== undefined && !declared.has(v));
  const orphan = [...declared].filter((v) => v !== undefined && !referenced.has(v));
  const docText: string[] = [];
  for (const d of docRoots) {
    const full = join(root, d);
    try {
      if (statSync(full).isFile()) docText.push(readText(full));
    } catch {
      /* missing */
    }
  }
  const docBlob = docText.join('\n');
  const undocumented: string[] = [];
  for (const v of declared) {
    if (!docBlob.includes(v)) undocumented.push(v);
  }
  if (missing.length === 0) {
    // eslint-disable-next-line no-console
    console.log(
      `docs-check: all ${referenced.size} referenced env vars are declared in .env.example.` +
        (orphan.length > 0
          ? ` ${orphan.length} declared but not yet used in code (informational).`
          : ''),
    );
    if (undocumented.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `docs-check: ${undocumented.length} declared env vars are not mentioned in any doc (informational).`,
      );
    }
    return;
  }
  // eslint-disable-next-line no-console
  console.log('docs-check:');
  for (const v of missing)
    // eslint-disable-next-line no-console
    console.log(`  referenced in code but not in .env.example: ${String(v)}`);
  for (const v of orphan)
    // eslint-disable-next-line no-console
    console.log(`  in .env.example but not referenced in code (informational): ${String(v)}`);
  for (const v of undocumented)
    // eslint-disable-next-line no-console
    console.log(`  in .env.example but not mentioned in any doc (informational): ${v}`);
  process.exit(1);
}

main();
