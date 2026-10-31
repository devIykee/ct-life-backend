/**
 * Web origins: the browser origins allowed to call this backend (env `WEB_ORIGINS`),
 * and the SIWS domain / URI each of them signs in with.
 *
 * One list drives three checks:
 *   - CORS on the REST API (only these origins get `Access-Control-Allow-Origin`);
 *   - the realtime server's WebSocket upgrade and matchmaking (a present Origin must
 *     be on the list; no Origin is a native client and is allowed);
 *   - SIWS: a challenge requested from one of these origins is bound to that origin's
 *     host as the `domain` and `<origin>/` as the `URI`.
 *
 * Pure: no I/O, no env reads.
 */

/** Thrown for a malformed `WEB_ORIGINS` entry; the config loader names the variable. */
export class WebOriginsEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebOriginsEnvError';
  }
}

/**
 * Parse `WEB_ORIGINS`: a comma list of exact origins such as
 * `https://play.ctlife.fun,https://staging.play.ctlife.fun`.
 *
 * Every entry must be a bare `scheme://host[:port]` origin (a trailing slash is
 * tolerated). `*`, `null`, paths, query strings, credentials and non-http(s) schemes
 * throw: there is no wildcard. Plain `http` is accepted only for `localhost` and
 * `127.0.0.1` (local WebGL testing). Entries are lower-cased and de-duplicated.
 *
 * @param raw - The env value, or undefined when unset.
 * @returns The allowed origins, normalised.
 */
export function parseWebOrigins(raw: string | undefined): readonly string[] {
  const out: string[] = [];
  for (const part of (raw ?? '').split(',')) {
    const entry = part.trim();
    if (entry === '') continue;
    const origin = normaliseConfiguredOrigin(entry);
    if (!out.includes(origin)) out.push(origin);
  }
  return out;
}

function normaliseConfiguredOrigin(entry: string): string {
  // WHATWG URL accepts `*` inside a hostname (`https://*.ctlife.fun`), so refuse it by hand.
  if (entry.includes('*') || entry.toLowerCase() === 'null') {
    throw new WebOriginsEnvError(`"${entry}" is not allowed; list exact origins`);
  }
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    throw new WebOriginsEnvError(`"${entry}" is not a URL origin like https://play.ctlife.fun`);
  }
  const bare = entry.replace(/\/$/, '').toLowerCase();
  if (url.origin.toLowerCase() !== bare || url.username !== '' || url.password !== '') {
    throw new WebOriginsEnvError(`"${entry}" must be a bare origin (scheme://host[:port])`);
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new WebOriginsEnvError(`"${entry}" must be https (http only for localhost)`);
  }
  return url.origin.toLowerCase();
}

/**
 * @param origin - The request's `Origin` header value.
 * @param allowed - The parsed `WEB_ORIGINS`.
 * @returns The allowed origin it matches (normalised), or null.
 */
export function matchWebOrigin(
  origin: string | undefined | null,
  allowed: readonly string[],
): string | null {
  if (origin === undefined || origin === null || origin === '') return null;
  const v = origin.trim().toLowerCase();
  return allowed.includes(v) ? v : null;
}

/** The outcome of an Origin check for a realtime / WebSocket request. */
export type OriginVerdict = 'native' | 'allowed' | 'refused';

/**
 * Check a realtime request's Origin. No Origin = a native client (allowed); an Origin
 * on the list = allowed; anything else (including the literal `null`) = refused.
 *
 * @param origin - The request's `Origin` header value.
 * @param allowed - The parsed `WEB_ORIGINS`.
 * @returns The verdict.
 */
export function checkRealtimeOrigin(
  origin: string | undefined | null,
  allowed: readonly string[],
): OriginVerdict {
  if (origin === undefined || origin === null || origin === '') return 'native';
  return matchWebOrigin(origin, allowed) !== null ? 'allowed' : 'refused';
}

/** The SIWS `domain` and `URI` a sign-in message must carry. */
export interface SiwsBinding {
  readonly domain: string;
  readonly uri: string;
}

/**
 * The SIWS binding for an allowed web origin: `domain` is the origin's host (with the
 * port when it is not the default, which is what wallets compare against the page),
 * `uri` is the origin with a trailing slash.
 *
 * @param origin - A normalised allowed origin.
 * @returns The binding.
 */
export function siwsBindingForOrigin(origin: string): SiwsBinding {
  const url = new URL(origin);
  return { domain: url.host, uri: `${url.origin}/` };
}

/**
 * Every SIWS binding this deployment accepts: the native one first, then one per web
 * origin.
 *
 * @param native - `SIWS_DOMAIN` / `SIWS_URI`.
 * @param webOrigins - The parsed `WEB_ORIGINS`.
 * @returns The allow-list.
 */
export function siwsAllowList(native: SiwsBinding, webOrigins: readonly string[]): SiwsBinding[] {
  const out: SiwsBinding[] = [native];
  for (const o of webOrigins) {
    const b = siwsBindingForOrigin(o);
    if (!out.some((x) => x.domain === b.domain && x.uri === b.uri)) out.push(b);
  }
  return out;
}
