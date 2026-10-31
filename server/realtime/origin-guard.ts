/**
 * Origin checks for the realtime (Colyseus) server.
 *
 * The browser build talks to Colyseus twice: an HTTP POST to `/matchmake/...` for a
 * seat, then a WebSocket upgrade. Both carry the page's `Origin`. The rule is the one
 * the REST API uses (`WEB_ORIGINS`, shared/domain/web-origins.ts):
 *
 *   - no Origin: a native client (the Android app), allowed;
 *   - an Origin in `WEB_ORIGINS`: allowed;
 *   - any other Origin (including the literal `null`): refused with `403`.
 *
 * Browsers always send Origin on a WebSocket handshake and on cross-origin requests,
 * and a page cannot change it, so this stops another site from opening a socket in a
 * visitor's browser. [Inference] A non-browser client can send any Origin or none; the
 * room's own JWT check in `onAuth` stays the authentication.
 *
 * Colyseus' matchmaker answers CORS by echoing any Origin with credentials allowed
 * (@colyseus/core 0.18 `matchmaker/controller.ts`). `installMatchmakeCors` replaces that
 * with the allow-list.
 */
import type { BeforeUpgradeHandler } from 'colyseus';
import { matchMaker } from 'colyseus';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { checkRealtimeOrigin, matchWebOrigin } from '../shared/domain/web-origins.js';

/** Request headers a browser may send to `/matchmake/*`. */
const MATCHMAKE_ALLOWED_HEADERS =
  'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Client-Version, X-Client-Platform, X-Client-Build';

/**
 * The `beforeUpgrade` hook for `WebSocketTransport`: refuse an upgrade whose Origin is
 * present and not allowed.
 *
 * @param allowed - The parsed `WEB_ORIGINS`.
 * @returns The handler.
 */
export function originBeforeUpgrade(allowed: readonly string[]): BeforeUpgradeHandler {
  return (request) => {
    if (checkRealtimeOrigin(request.headers.get('origin'), allowed) === 'refused') {
      return new Response(null, { status: 403 });
    }
    return undefined;
  };
}

/**
 * Point Colyseus' matchmaker CORS at the allow-list: an allowed Origin is echoed exactly
 * and any other request gets no usable `Access-Control-Allow-Origin` (`null`). Credentials
 * stay allowed because the Colyseus JS SDK sends matchmake requests with
 * `credentials: 'include'`; that is safe only because the origin is never a wildcard.
 *
 * @param allowed - The parsed `WEB_ORIGINS`.
 */
export function installMatchmakeCors(allowed: readonly string[]): void {
  const c = matchMaker.controller;
  // Allow-Origin here is only the fallback; getCorsHeaders below always overrides it.
  const defaults = {
    'Access-Control-Allow-Origin': 'null',
    'Access-Control-Allow-Headers': MATCHMAKE_ALLOWED_HEADERS,
    'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
  c.DEFAULT_CORS_HEADERS = defaults;
  c.getCorsHeaders = (headers: Headers): Record<string, string> => {
    const match = matchWebOrigin(headers.get('origin'), allowed);
    return { 'Access-Control-Allow-Origin': match ?? 'null' };
  };
}

/**
 * For the HTTP dispatcher in front of Colyseus: answer `403` to a `/matchmake/*` request
 * whose Origin is present and not allowed. Returns true when it answered.
 *
 * @param req - The HTTP request.
 * @param res - The HTTP response.
 * @param allowed - The parsed `WEB_ORIGINS`.
 * @returns True when the request was refused (and answered).
 */
export function refuseDisallowedMatchmake(
  req: IncomingMessage,
  res: ServerResponse,
  allowed: readonly string[],
): boolean {
  if (!(req.url ?? '').startsWith('/matchmake/')) return false;
  const origin = req.headers.origin;
  if (checkRealtimeOrigin(origin, allowed) !== 'refused') return false;
  res.writeHead(403, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Origin not allowed.' } }));
  return true;
}
