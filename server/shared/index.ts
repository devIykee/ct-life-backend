/**
 * Barrel for server/shared. Imports from here are stable; the
 * composition roots (server/api/main.ts, server/realtime/main.ts,
 * server/workers/main.ts) build their dependency graph off this
 * barrel. The boundary check (tools/scripts/boundary-check.ts) and
 * the ESLint `no-restricted-imports` rule both rely on this single
 * surface.
 */
export * from './config/config.js';
export * from './logger/logger.js';
export * from './db/pool.js';
export * from './db/uow.js';
export * from './redis/client.js';
export * from './auth/jwt.js';
export * from './solana/helius.js';
export * from './solana/keypair.js';
export * from './livekit/token.js';
export * from './s3/client.js';
export * from './infra/error-envelope.js';
export * from './infra/idempotency.js';
export * from './infra/rate-limit.js';
