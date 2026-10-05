/**
 * Docs-check.
 *
 * Verifies the documentation invariants required by the amendment:
 *
 *   1. Every env var referenced in code (server/, packages/, tools/) is
 *      declared in .env.example and the README.
 *   2. Every error code in contract/ids/errors.json appears in
 *      contract/openapi.yaml (when M1 publishes the IDL).
 *   3. Every realtime message in contract/realtime/*.ts is referenced in
 *      docs/REALTIME.md (when M1 publishes the schemas).
 *   4. Every relative Markdown link in docs/*.md resolves to a real file.
 *
 * Run: pnpm docs:check
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const REPO = process.cwd();
const CODE_ROOTS = ['server', 'packages', 'tools'];

const ENV_VAR_PATTERNS: readonly RegExp[] = [
  /process\.env\.([A-Z][A-Z0-9_]+)/g,
  /\benv\.([A-Z][A-Z0-9_]+)/g,
  /import\.meta\.env\.([A-Z][A-Z0-9_]+)/g,
];

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

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'target',
  '.git',
  '.runtime',
]);
const SOURCE_EXT = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const MD_EXT = new Set(['.md']);

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
    else if (SOURCE_EXT.has(extname(p)) || MD_EXT.has(extname(p))) out.push(p);
  }
  return out;
}

function readText(p: string): string {
  return readFileSync(p, 'utf8');
}

function extractEnvRefs(): Set<string> {
  const found = new Set<string>();
  for (const root of CODE_ROOTS) {
    const full = join(REPO, root);
    try {
      statSync(full);
    } catch {
      continue;
    }
    for (const file of walk(full)) {
      // The script itself defines patterns; skip it to avoid self-match.
      if (file.endsWith('docs-check.ts')) continue;
      const text = readText(file);
      for (const re of ENV_VAR_PATTERNS) {
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
  const text = readText(join(REPO, '.env.example'));
  const out = new Set<string>();
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z][A-Z0-9_]+)\s*=/);
    const v = m ? m[1] : undefined;
    if (v !== undefined) out.add(v);
  }
  return out;
}

function extractReadmeVars(): Set<string> {
  // README mentions env vars either in code spans (like `HELIUS_API_KEY`)
  // or as bare tokens inside a table cell. We collect both.
  const text = readText(join(REPO, 'README.md'));
  const out = new Set<string>();
  for (const re of [/`([A-Z][A-Z0-9_]+)`/g, /\b([A-Z][A-Z0-9_]{3,})\b/g]) {
    for (const m of text.matchAll(re)) {
      const v = m[1];
      if (!v) continue;
      if (v.length < 4) continue;
      if (v.length > 40) continue;
      if (ALLOWLIST.has(v)) continue;
      out.add(v);
    }
  }
  return out;
}

function extractErrorCodes(): Set<string> {
  const path = join(REPO, 'contract/ids/errors.json');
  try {
    const text = readText(path);
    const parsed = JSON.parse(text) as {
      codes?: Array<{ code: string }> | Record<string, unknown>;
    };
    const codes = new Set<string>();
    if (Array.isArray(parsed.codes)) {
      for (const c of parsed.codes) {
        if (typeof c.code === 'string') codes.add(c.code);
      }
    } else if (parsed.codes && typeof parsed.codes === 'object') {
      for (const k of Object.keys(parsed.codes)) codes.add(k);
    }
    return codes;
  } catch {
    return new Set();
  }
}

function extractOpenapiErrors(): Set<string> {
  const path = join(REPO, 'contract/openapi.yaml');
  try {
    const text = readText(path);
    const out = new Set<string>();
    // YAML match for `code: SOME_ERROR` lines.
    for (const m of text.matchAll(/^\s*code:\s*([A-Z][A-Z0-9_]+)\s*$/gm)) {
      const v = m[1];
      if (v) out.add(v);
    }
    return out;
  } catch {
    return new Set();
  }
}

function extractRealtimeMessages(): Set<string> {
  // The M1 file contract/realtime/messages.ts (or similar) will export a
  // list of message types. Until M1, the set is empty. The check is a
  // no-op until M1.
  const candidates = [
    join(REPO, 'contract/realtime/messages.ts'),
    join(REPO, 'contract/realtime/index.ts'),
  ];
  const out = new Set<string>();
  for (const file of candidates) {
    try {
      const text = readText(file);
      // Match `name: 'move' | 'sit' | ...` style and `export const X = 'Y'`.
      for (const m of text.matchAll(/name:\s*['"]([a-z_]+)['"]/g)) {
        const v = m[1];
        if (v) out.add(v);
      }
      for (const m of text.matchAll(/export const (\w+)\s*=\s*['"]([a-z_]+)['"]/g)) {
        const v = m[2];
        if (v) out.add(v);
      }
    } catch {
      /* missing is fine until M1 */
    }
  }
  return out;
}

function extractRealtimeRejections(): Set<string> {
  // Codes listed in the RejectedMessage z.enum in contract/realtime/messages.ts.
  const out = new Set<string>();
  try {
    const text = readText(join(REPO, 'contract/realtime/messages.ts'));
    // Find the z.enum([ ... ]) inside RejectedMessage and capture every
    // single-quoted string.
    const re = /z\.enum\(\[\s*([^\]]+)\s*\]\)/g;
    for (const m of text.matchAll(re)) {
      const list = m[1];
      if (!list) continue;
      for (const c of list.matchAll(/'([A-Z][A-Z0-9_]+)'/g)) {
        const v = c[1];
        if (v) out.add(v);
      }
    }
  } catch {
    /* missing is fine until M1 */
  }
  return out;
}

function extractRealtimeMdMessages(): Set<string> {
  const path = join(REPO, 'docs/REALTIME.md');
  try {
    const text = readText(path);
    const out = new Set<string>();
    for (const m of text.matchAll(/`([a-z_]+)`/g)) {
      const v = m[1];
      if (v && /^[a-z][a-z0-9_]*$/.test(v)) out.add(v);
    }
    return out;
  } catch {
    return new Set();
  }
}

function checkMarkdownLinks(): string[] {
  const out: string[] = [];
  const docsRoot = join(REPO, 'docs');
  for (const file of walk(docsRoot)) {
    if (!MD_EXT.has(extname(file))) continue;
    const text = readText(file);
    // Match [text](relative-path) — skip absolute URLs and in-page anchors.
    for (const m of text.matchAll(/\[[^\]]*\]\((?!https?:\/\/|#)([^)]+)\)/g)) {
      const spec = m[1];
      if (!spec) continue;
      // Strip in-page anchor and query.
      const [pathPart] = spec.split('#');
      const [pathOnly] = pathPart?.split('?') ?? [];
      if (!pathOnly) continue;
      // Resolve relative to the file.
      const fileDir = file.split('/').slice(0, -1).join('/');
      const target = pathOnly.startsWith('/') ? join(REPO, pathOnly) : join(fileDir, pathOnly);
      try {
        statSync(target);
      } catch {
        out.push(`${file.replace(`${REPO}/`, '')}: broken link ${spec} -> ${target}`);
      }
    }
  }
  return out;
}

function main(): void {
  let failed = false;

  // (1) env vars referenced in code appear in .env.example AND README.
  const referenced = extractEnvRefs();
  const declaredExample = extractEnvExampleVars();
  const declaredReadme = extractReadmeVars();
  const missingExample = [...referenced].filter((v) => !declaredExample.has(v));
  const missingReadme = [...referenced].filter((v) => !declaredReadme.has(v));
  if (missingExample.length > 0 || missingReadme.length > 0) {
    failed = true;
    for (const v of missingExample) {
    }
    for (const v of missingReadme) {
    }
  }

  // (2) every error code in errors.json appears in openapi.yaml OR in
  // the realtime RejectedMessage enum.
  const errorCodes = extractErrorCodes();
  const openapiCodes = extractOpenapiErrors();
  if (errorCodes.size > 0) {
    const realtimeRej = extractRealtimeRejections();
    const missingFromAnywhere = [...errorCodes].filter(
      (c) => !openapiCodes.has(c) && !realtimeRej.has(c),
    );
    if (missingFromAnywhere.length > 0) {
      failed = true;
      for (const c of missingFromAnywhere) {
          `  error code ${c} from contract/ids/errors.json not in openapi.yaml or contract/realtime/messages.ts`,
        );
      }
    }
  }

  // (3) every realtime message appears in docs/REALTIME.md.
  const messages = extractRealtimeMessages();
  const mdMessages = extractRealtimeMdMessages();
  if (messages.size > 0) {
    const missingFromMd = [...messages].filter((m) => !mdMessages.has(m));
    if (missingFromMd.length > 0) {
      failed = true;
      for (const m of missingFromMd) {
      }
    }
  }

  // (4) every relative Markdown link in docs/*.md resolves.
  const brokenLinks = checkMarkdownLinks();
  if (brokenLinks.length > 0) {
    failed = true;
    for (const l of brokenLinks) {
    }
  }

  if (!failed) {
      `docs-check: OK (${referenced.size} env vars in code, ${errorCodes.size} error codes, ${messages.size} realtime messages, ${brokenLinks.length === 0 ? 'all links resolve' : 'all links resolve'}).`,
    );
    process.exit(0);
  }
  process.exit(1);
}

main();
