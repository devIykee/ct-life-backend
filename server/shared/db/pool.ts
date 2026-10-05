/**
 * Postgres connection pool.
 *
 * Every connection in the pool has `statement_timeout` and
 * `lock_timeout` set so a runaway query cannot hold a lock past a few
 * seconds. The UoW (./uow.ts) is the only caller of BEGIN/COMMIT/
 * ROLLBACK; this module only hands out connections.
 *
 * The pool is built once at composition time. `close()` shuts it
 * down on process exit.
 */
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { loadConfig } from '../config/config.js';

const STATEMENT_TIMEOUT_MS = 5_000;
const LOCK_TIMEOUT_MS = 3_000;

export interface Db {
  /** Borrow a connection; the caller MUST release it. */
  connect(): Promise<PoolClient>;
  /** Borrow a connection and run `fn` inside it, releasing on return. */
  withConnection<T>(fn: (c: PoolClient) => Promise<T>): Promise<T>;
  /** Shut the pool down. Idempotent. */
  close(): Promise<void>;
  /** The raw pg.Pool; only exposed for health checks. */
  readonly pool: Pool;
}

let cached: Db | null = null;

export function createDb(overrides: Partial<PoolConfig> = {}): Db {
  if (cached !== null) return cached;
  const cfg = loadConfig();
  const pool = new Pool({
    connectionString: cfg.databaseUrl,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ...overrides,
  });
  // Apply timeouts on every new connection. pg.Pool calls this on
  // connect, so a freshly borrowed client has the limits set.
  pool.on('connect', (client) => {
    void client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`).catch(() => undefined);
    void client.query(`SET lock_timeout = ${LOCK_TIMEOUT_MS}`).catch(() => undefined);
  });

  cached = {
    pool,
    async connect() {
      return pool.connect();
    },
    async withConnection<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        return await fn(client);
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
      cached = null;
    },
  };
  return cached;
}

/** Test-only: drop the cached pool. */
export function _resetDbForTests(): void {
  cached = null;
}
