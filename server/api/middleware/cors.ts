/**
 * CORS for the REST API (the browser build at e.g. https://play.ctlife.fun).
 *
 * - Only origins in `WEB_ORIGINS` get `Access-Control-Allow-Origin`, echoed exactly.
 *   There is no wildcard, and `Vary: Origin` is always sent.
 * - `Access-Control-Allow-Credentials: true`, only ever next to an exact, allow-listed
 *   origin (browsers refuse credentials with `*`, and we never send `*`). The API sets no
 *   cookies and authenticates with `Authorization: Bearer`, so this grants no ambient
 *   authority; it is on so a client stack that defaults to `credentials: 'include'`
 *   (the Colyseus JS SDK does, `@colyseus/sdk` HTTP.ts; Unity WebGL UnityWebRequest
 *   [Unverified]) is not blocked.
 * - A preflight (`OPTIONS` with `Origin` and `Access-Control-Request-Method`) from an
 *   allowed origin answers `204` with the allowed methods and headers. From any other
 *   origin it gets no CORS headers (the browser then blocks the real request).
 * - A request without `Origin` (the Android app, server-to-server webhooks) is not
 *   touched: no CORS headers, nothing refused.
 *
 * Uses @fastify/cors (already a dependency; 10.x supports Fastify 5).
 */
import cors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';
import { matchWebOrigin } from '../../shared/domain/web-origins.js';

/** Request headers the clients send. Content-Type is listed because JSON is not CORS-safelisted. */
export const CORS_ALLOWED_HEADERS = [
  'Authorization',
  'Content-Type',
  'Idempotency-Key',
  'If-None-Match',
  'X-Client-Version',
  'X-Contract-Version',
  'X-Client-Platform',
  'X-Client-Build',
  'X-Request-Id',
] as const;

/** Response headers a browser client may read. */
export const CORS_EXPOSED_HEADERS = ['ETag', 'Retry-After', 'X-Request-Id'] as const;

export const CORS_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** Seconds a browser may cache a preflight. Short, so a header-list change lands fast. */
export const CORS_MAX_AGE_SEC = 600;

/**
 * Register CORS. Call before any route is registered.
 * @param app - The Fastify instance.
 * @param allowedOrigins - The parsed `WEB_ORIGINS`.
 */
export async function registerCors(
  app: FastifyInstance,
  allowedOrigins: readonly string[],
): Promise<void> {
  await app.register(cors, {
    // Called with the request's Origin (undefined when absent). true echoes that exact
    // origin; false leaves the response without CORS headers.
    origin: (origin, cb) => cb(null, matchWebOrigin(origin, allowedOrigins) !== null),
    credentials: true,
    methods: [...CORS_METHODS],
    allowedHeaders: [...CORS_ALLOWED_HEADERS],
    exposedHeaders: [...CORS_EXPOSED_HEADERS],
    maxAge: CORS_MAX_AGE_SEC,
    strictPreflight: true,
  });
}
