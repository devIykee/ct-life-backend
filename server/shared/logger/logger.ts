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
