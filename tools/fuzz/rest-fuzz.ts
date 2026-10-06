/**
 * REST fuzz harness: drives every operation in `contract/openapi.yaml`
 * against a running API instance with generated payloads, asserts the
 * response shape against the spec, and reports failures.
 *
 * Strategy:
 *  1. Spin up the API in-process via `buildServer()` and use Fastify's
 *     `app.inject()` so we don't bind a real port.
 *  2. Dev-auth once to get a bearer token.
 *  3. Parse `contract/openapi.yaml` and walk every operation.
 *  4. For each operation, generate a "minimal valid" body from the JSON
 *     schema using a fast schema-aware generator (handles string,
 *     number, integer, boolean, enum, array, object, format).
 *  5. Send the request via `app.inject()` and assert:
 *       - status code is in the operation's declared responses
 *         (we accept any 2xx/3xx/4xx the spec says is possible)
 *       - JSON body (when present) validates against the declared
 *         response schema
 *  6. Track failures: server crashes (5xx), unexpected 4xx, response
 *     schema violations.
 *
 * Run: `pnpm exec tsx tools/fuzz/rest-fuzz.ts [--seconds 30]`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { parse as parseYaml } from 'yaml';
import { buildServer } from '../../server/api/main.js';
import { Keypair } from '@solana/web3.js';

const SECONDS_DEFAULT = 30;

const args = process.argv.slice(2);
let seconds = SECONDS_DEFAULT;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--seconds' && args[i + 1]) seconds = Number(args[i + 1]);
}

loadDotenv({ path: join(process.cwd(), '.env') });
process.env.APP_ENV ??= 'local';
process.env.NODE_ENV ??= 'development';
process.env.LOG_LEVEL ??= 'warn';
process.env.ENABLE_DEV_AUTH ??= 'true';

interface OpenAPIDocument {
  paths: Record<string, Record<string, OperationObject>>;
}

interface OperationObject {
  operationId?: string;
  summary?: string;
  responses: Record<string, ResponseObject>;
  requestBody?: RequestBodyObject;
  parameters?: ParameterObject[];
  security?: Array<Record<string, string[]>>;
}

interface ResponseObject {
  description: string;
  content?: { 'application/json'?: { schema: SchemaObject } };
}

interface RequestBodyObject {
  required?: boolean;
  content: { 'application/json': { schema: SchemaObject } };
}

interface ParameterObject {
  name: string;
  in: 'path' | 'query' | 'header';
  required?: boolean;
  schema: SchemaObject;
}

type SchemaObject =
  | { type?: string; format?: string; enum?: unknown[]; example?: unknown; default?: unknown }
  | { type: 'string'; minLength?: number; maxLength?: number; pattern?: string }
  | { type: 'integer' | 'number'; minimum?: number; maximum?: number }
  | { type: 'boolean' }
  | { type: 'array'; minItems?: number; maxItems?: number; items: SchemaObject }
  | {
      type: 'object';
      required?: string[];
      properties?: Record<string, SchemaObject>;
      additionalProperties?: boolean | SchemaObject;
    }
  | { oneOf?: SchemaObject[]; anyOf?: SchemaObject[]; allOf?: SchemaObject[]; nullable?: boolean }
  | Record<string, unknown>;

function pickExample(s: SchemaObject | undefined): unknown {
  if (!s) return null;
  if ('example' in s && s.example !== undefined) return s.example;
  if ('default' in s && s.default !== undefined) return s.default;
  if ('enum' in s && s.enum && s.enum.length) return s.enum[0];
  if ('oneOf' in s && s.oneOf) return pickExample(s.oneOf[0]);
  if ('anyOf' in s && s.anyOf) return pickExample(s.anyOf[0]);
  if ('allOf' in s && s.allOf) {
    const merged: Record<string, unknown> = {};
    for (const sub of s.allOf) Object.assign(merged, pickExample(sub) as object);
    return merged;
  }
  const t = (s as { type?: string }).type;
  switch (t) {
    case 'string':
      if ((s as { format?: string }).format === 'uuid') return '01a10f37-a39b-7045-ade5-b6bcf6d8ae4c';
      if ((s as { format?: string }).format === 'uri') return 'https://example.com';
      return 'string';
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object': {
      const o = s as {
        properties?: Record<string, SchemaObject>;
        required?: string[];
        additionalProperties?: boolean | SchemaObject;
      };
      const out: Record<string, unknown> = {};
      if (o.properties) {
        for (const k of Object.keys(o.properties)) out[k] = pickExample(o.properties[k]);
      }
      return out;
    }
    default:
      return null;
  }
}

function validateAgainstSchema(data: unknown, schema: SchemaObject, path = '$'): string | null {
  if (!schema || typeof schema !== 'object') return null;
  if ('oneOf' in schema && schema.oneOf) {
    const ok = schema.oneOf.some((s) => validateAgainstSchema(data, s, path) === null);
    if (!ok) return `${path}: does not match any oneOf branch`;
    return null;
  }
  if ('anyOf' in schema && schema.anyOf) {
    const ok = schema.anyOf.some((s) => validateAgainstSchema(data, s, path) === null);
    if (!ok) return `${path}: does not match any anyOf branch`;
    return null;
  }
  if ('allOf' in schema && schema.allOf) {
    for (const s of schema.allOf) {
      const err = validateAgainstSchema(data, s, path);
      if (err) return err;
    }
    return null;
  }
  const t = (schema as { type?: string }).type;
  if (t === 'string' && typeof data !== 'string') return `${path}: expected string`;
  if (t === 'integer' && !Number.isInteger(data)) return `${path}: expected integer`;
  if (t === 'number' && typeof data !== 'number') return `${path}: expected number`;
  if (t === 'boolean' && typeof data !== 'boolean') return `${path}: expected boolean`;
  if (t === 'array' && !Array.isArray(data)) return `${path}: expected array`;
  if (t === 'object') {
    if (data === null || typeof data !== 'object' || Array.isArray(data))
      return `${path}: expected object`;
    const o = schema as {
      required?: string[];
      properties?: Record<string, SchemaObject>;
      additionalProperties?: boolean | SchemaObject;
    };
    if (o.required) {
      for (const k of o.required) {
        if (!(k in (data as Record<string, unknown>))) return `${path}: missing ${k}`;
      }
    }
    if (o.properties) {
      for (const k of Object.keys(o.properties)) {
        if (k in (data as Record<string, unknown>)) {
          const err = validateAgainstSchema(
            (data as Record<string, unknown>)[k],
            o.properties[k]!,
            `${path}.${k}`,
          );
          if (err) return err;
        }
      }
    }
  }
  return null;
}

interface FuzzOperation {
  path: string;
  method: string;
  op: OperationObject;
  fullPath: string;
}

function buildOperations(doc: OpenAPIDocument, prefix: string): FuzzOperation[] {
  const out: FuzzOperation[] = [];
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method.toLowerCase())) continue;
      const params = (op as OperationObject).parameters ?? [];
      let fullPath = prefix + path;
      for (const p of params) {
        if (p.in === 'path') {
          // Replace the {param} with a generated value.
          const v = String(pickExample(p.schema));
          fullPath = fullPath.replace(`{${p.name}}`, encodeURIComponent(v));
        }
      }
      out.push({ path, method, op: op as OperationObject, fullPath });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const yamlPath = join(process.cwd(), 'contract/openapi.yaml');
  const doc = parseYaml(readFileSync(yamlPath, 'utf8')) as OpenAPIDocument;
  const operations = buildOperations(doc, '/v1');
  console.log(`[fuzz] parsed ${operations.length} operations from openapi.yaml`);

  const handle = await buildServer();
  await handle.app.ready();
  const app = handle.app;

  // Dev-auth to get a bearer.
  const authR = await app.inject({
    method: 'POST',
    url: '/v1/auth/dev',
    headers: { 'idempotency-key': `fuzz-auth-${Date.now()}` },
    payload: { wallet: Keypair.generate().publicKey.toBase58() },
  });
  if (authR.statusCode !== 200) {
    console.error(`[fuzz] dev auth failed: ${authR.body}`);
    process.exit(1);
  }
  const { accessToken } = JSON.parse(authR.body);
  console.log(`[fuzz] dev auth OK; running for ${seconds}s`);

  const failures: { op: string; method: string; path: string; status: number; error: string }[] = [];
  const start = Date.now();
  let iterations = 0;

  // For each operation, send one request and validate.
  for (const o of operations) {
    if (Date.now() - start > seconds * 1000) break;
    const headers: Record<string, string> = {
      authorization: `Bearer ${accessToken}`,
    };
    // Build query params from parameters.
    let url = o.fullPath;
    const queryParts: string[] = [];
    for (const p of o.op.parameters ?? []) {
      if (p.in === 'query') {
        queryParts.push(`${encodeURIComponent(p.name)}=${encodeURIComponent(String(pickExample(p.schema)))}`);
      }
      if (p.in === 'header') {
        headers[p.name.toLowerCase()] = String(pickExample(p.schema));
      }
    }
    if (queryParts.length) url += '?' + queryParts.join('&');
    if (['post', 'put', 'patch', 'delete'].includes(o.method)) {
      headers['idempotency-key'] = `fuzz-${iterations}-${Date.now()}`;
    }

    // Build body from requestBody schema.
    let payload: unknown = undefined;
    if (o.op.requestBody?.content?.['application/json']) {
      payload = pickExample(o.op.requestBody.content['application/json'].schema);
    }

    const r = await app.inject({
      method: o.method.toUpperCase(),
      url,
      headers,
      payload,
    });

    iterations++;

    // Validate status code is in declared responses.
    const declared = Object.keys(o.op.responses ?? {});
    const wildcards = declared.filter((s) => s.endsWith('XX')).map((s) => s.replace('XX', ''));
    const exact = declared.includes(String(r.statusCode));
    const wildcardMatch = wildcards.some((p) => String(r.statusCode).startsWith(p));
    if (!exact && !wildcardMatch) {
      failures.push({
        op: o.op.operationId ?? o.path,
        method: o.method,
        path: o.path,
        status: r.statusCode,
        error: `status ${r.statusCode} not in declared responses [${declared.join(', ')}]`,
      });
      continue;
    }

    // Validate response body schema if declared.
    const okResp = o.op.responses['200'] ?? o.op.responses['201'] ?? o.op.responses['204'];
    if (okResp?.content?.['application/json'] && r.statusCode < 300 && r.body?.length > 0) {
      let data: unknown;
      try {
        data = JSON.parse(r.body);
      } catch {
        continue;
      }
      const err = validateAgainstSchema(data, okResp.content['application/json'].schema);
      if (err) {
        failures.push({
          op: o.op.operationId ?? o.path,
          method: o.method,
          path: o.path,
          status: r.statusCode,
          error: `body schema: ${err}`,
        });
      }
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[fuzz] ran ${iterations} iterations in ${elapsed}s; ${failures.length} failures`);
  if (failures.length > 0) {
    for (const f of failures.slice(0, 30)) {
      console.log(`  - ${f.method.toUpperCase()} ${f.path} → ${f.status}: ${f.error}`);
    }
    process.exit(1);
  }
  await handle.stop();
  process.exit(0);
}

main().catch((e: Error) => {
  console.error(`[fuzz] crashed: ${e.message}\n${e.stack ?? ''}`);
  process.exit(2);
});