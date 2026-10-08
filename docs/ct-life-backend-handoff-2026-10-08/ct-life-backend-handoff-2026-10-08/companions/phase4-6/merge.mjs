#!/usr/bin/env node
/**
 * Merge the Phase 4-6 proposal into an rc1 openapi.yaml and run the
 * contract cross-checks that do not need the backend repo's tooling.
 *
 *   node merge.mjs <base openapi.yaml> <openapi-additions.yaml> <out.yaml> [--fix-nullable]
 *
 * Needs the `yaml` package (2.x). It is resolved from the current working
 * directory, so run it from the backend repo root (which depends on yaml
 * 2.9.1) or from any folder where `npm i yaml@2.9.1` was run.
 *
 * The merge is strictly additive and fails on any collision:
 *   - tags: appended when the name is new;
 *   - paths: new paths added; on an existing path only new HTTP methods
 *     are added (an existing method is a collision);
 *   - components.{schemas,parameters,responses}: new names only.
 *
 * --fix-nullable rewrites rc1's OpenAPI 3.0 `nullable: true` into the 3.1
 * form (`type: [T, 'null']`) in the merged output only, to show that the
 * merged document is error-free once that rc1 issue is fixed. It never
 * touches the input files.
 *
 * After writing, it checks:
 *   - every `$ref: '#/components/...'` in the merged doc resolves;
 *   - every operationId is unique;
 *   - every error code used as `code: '<CODE>'` in the additions exists in
 *     contract/ids/errors.json or in ids-additions.json.
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(join(process.cwd(), 'package.json'));
const YAML = require('yaml');

const [baseArg, addArg, outArg, ...flags] = process.argv.slice(2);
if (!baseArg || !addArg || !outArg) {
  console.error('usage: node merge.mjs <base.yaml> <additions.yaml> <out.yaml> [--fix-nullable]');
  process.exit(2);
}
const fixNullable = flags.includes('--fix-nullable');
const here = dirname(fileURLToPath(import.meta.url));

const base = YAML.parse(readFileSync(baseArg, 'utf8'));
const add = YAML.parse(readFileSync(addArg, 'utf8'));
const problems = [];
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

// Tags
base.tags ??= [];
const tagNames = new Set(base.tags.map((t) => t.name));
for (const t of add.tags ?? []) if (!tagNames.has(t.name)) base.tags.push(t);

// Paths
let addedOps = 0;
for (const [p, item] of Object.entries(add.paths ?? {})) {
  base.paths[p] ??= {};
  for (const [k, v] of Object.entries(item)) {
    if (METHODS.includes(k) && base.paths[p][k]) {
      problems.push(`collision: ${k.toUpperCase()} ${p} already exists in base`);
      continue;
    }
    if (METHODS.includes(k)) addedOps++;
    base.paths[p][k] = v;
  }
}

// Components
let addedComponents = 0;
for (const section of ['schemas', 'parameters', 'responses']) {
  base.components[section] ??= {};
  for (const [name, def] of Object.entries(add.components?.[section] ?? {})) {
    if (base.components[section][name]) {
      problems.push(`collision: components.${section}.${name} already exists in base`);
      continue;
    }
    base.components[section][name] = def;
    addedComponents++;
  }
}

// Optional: convert rc1 `nullable: true` to the 3.1 form in the output.
let nullableFixed = 0;
function fix(node) {
  if (Array.isArray(node)) return node.forEach(fix);
  if (!node || typeof node !== 'object') return;
  if (node.nullable === true) {
    delete node.nullable;
    if (typeof node.type === 'string') node.type = [node.type, 'null'];
    else if (node.$ref || node.allOf) {
      const inner = { ...node };
      for (const k of Object.keys(node)) delete node[k];
      node.anyOf = [inner, { type: 'null' }];
    }
    nullableFixed++;
  }
  for (const v of Object.values(node)) fix(v);
}
if (fixNullable) fix(base);

writeFileSync(outArg, YAML.stringify(base, { lineWidth: 0 }));

// Check: refs resolve.
const text = readFileSync(outArg, 'utf8');
for (const m of text.matchAll(/\$ref: ['"]?#\/components\/(\w+)\/(\w+)['"]?/g)) {
  if (!base.components[m[1]]?.[m[2]]) problems.push(`unresolved $ref #/components/${m[1]}/${m[2]}`);
}

// Check: operationIds unique.
const seen = new Map();
for (const [p, item] of Object.entries(base.paths)) {
  for (const k of METHODS) {
    const id = item[k]?.operationId;
    if (!id) continue;
    if (seen.has(id)) problems.push(`duplicate operationId ${id} (${seen.get(id)} and ${k} ${p})`);
    seen.set(id, `${k} ${p}`);
  }
}

// Check: every code in the additions is registered.
const known = new Set();
const errorsPath = resolve(dirname(baseArg), 'ids/errors.json');
try {
  for (const c of JSON.parse(readFileSync(errorsPath, 'utf8')).codes) known.add(c.code);
} catch {
  problems.push(`could not read ${errorsPath}`);
}
const idsAdd = JSON.parse(readFileSync(join(here, 'ids-additions.json'), 'utf8'));
for (const c of idsAdd.registries['errors.json'].codes) known.add(c.code);
const addText = readFileSync(addArg, 'utf8');
const used = new Set([...addText.matchAll(/code: ['"]?([A-Z_]+)['"]?/g)].map((m) => m[1]));
for (const c of used) if (!known.has(c)) problems.push(`error code ${c} is used but not registered`);
// And the reverse: every proposed REST code is referenced (mirrors openapi-vs-errors).
for (const c of idsAdd.registries['errors.json'].codes) {
  if (c.realtimeOnly) continue;
  if (!used.has(c.code)) problems.push(`proposed code ${c.code} is never referenced in the additions`);
}

console.log(
  `merged: +${addedOps} operations, +${addedComponents} components, ${seen.size} operationIds total` +
    (fixNullable ? `, ${nullableFixed} rc1 nullable fields converted` : ''),
);
if (problems.length) {
  console.log(problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
console.log('checks: refs resolve, operationIds unique, every error code registered and referenced');
