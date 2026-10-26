/**
 * Server logger (pino) with request IDs.
 *
 * Every log line is JSON, with `requestId` and the standard fields
 * (`level`, `time`, `msg`). The HTTP middleware and the realtime room
 * middleware set `requestId` on the Fastify request and the Colyseus
 * session respectively, then the rest of the code can call
 * `logger.child({ requestId }).info(…)` to attach it.
 *
 * No secret values are logged. The `redactPaths` list covers the
 * obvious offenders; any object passed to `.info({ … })` is filtered.
 */
import pino, { type Logger, type LoggerOptions } from 'pino';
import { loadConfig } from '../config/config.js';

/**
 * Paths pino censors. Besides secrets this covers a player's position (the
 * IRL check-in): coordinates must never reach a log line, nor a request
 * body, which Fastify does not log but we redact anyway as a second guard.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.body',
  'body',
  'password',
  'secret',
  'privateKey',
  'seed',
  'mnemonic',
  'lat',
  'lng',
  'latitude',
  'longitude',
  'accuracyM',
  '*.lat',
  '*.lng',
  '*.latitude',
  '*.longitude',
  '*.accuracyM',
] as const;

/**
 * Shorten a client address before it reaches a log line: IPv4 keeps the first
 * three octets (a.b.c.0), IPv6 keeps the first /48. Enough to spot an abusive
 * network, not enough to identify a household or device.
 * @param ip - The address as Fastify reports it (`request.ip`, behind trustProxy).
 * @returns The truncated address, or `unknown`.
 */
export function truncateIp(ip: string | undefined): string {
  if (!ip) return 'unknown';
  const dotted = ip.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (dotted) return `${dotted[1]}.${dotted[2]}.${dotted[3]}.0`;
  if (!ip.includes(':')) return 'unknown';
  const [head = '', tail = ''] = ip.split('::');
  const a = head === '' ? [] : head.split(':');
  const b = tail === '' || !ip.includes('::') ? [] : tail.split(':');
  const groups = ip.includes('::')
    ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b]
    : a;
  return groups.length >= 3 ? `${groups.slice(0, 3).join(':')}::` : 'unknown';
}

/**
 * Fastify request log shape: method and path only. No query string (it can
 * carry handles and ids), no port, no headers, and the client address is
 * truncated (see `truncateIp`).
 * @param req - The Fastify request.
 */
export function serializeRequest(req: {
  method?: string;
  url?: string;
  ip?: string;
}): Record<string, string> {
  return {
    method: req.method ?? '',
    path: (req.url ?? '').split('?')[0] ?? '',
    ip: truncateIp(req.ip),
  };
}

/**
 * Logger options for the HTTP server, shared with the test that checks them.
 * @param level - Log level.
 */
export function httpLoggerOptions(level: string): LoggerOptions {
  return {
    level,
    // Bodies are not logged by default; redact them (and any coordinates) anyway.
    redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' },
    serializers: { req: serializeRequest },
  };
}

let cached: Logger | null = null;

/**
 * Build the process-wide pino logger. Reads the log level from
 * `Config.logLevel`. Memoised; subsequent calls return the same
 * instance.
 */
export function createLogger(): Logger {
  if (cached !== null) return cached;
  const cfg = loadConfig();
  const opts: LoggerOptions = {
    level: cfg.logLevel,
    base: {
      app: 'ct-life',
      env: cfg.appEnv,
      pid: process.pid,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [...REDACT_PATHS],
      censor: '[REDACTED]',
    },
  };
  cached = pino(opts);
  return cached;
}

export type { Logger };
