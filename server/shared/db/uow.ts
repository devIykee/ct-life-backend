/**
 * Unit of Work.
 *
 * The only module in the codebase that calls `BEGIN`, `COMMIT` or
 * `ROLLBACK`. Every service that mutates more than one row runs its
 * writes inside a UoW. The UoW:
 *
 *   1. Borrows a single client from the pool.
 *   2. Sets `ISOLATION LEVEL SERIALIZABLE` for the transaction.
 *   3. Sets a per-transaction `statement_timeout` so a single bad
 *      statement cannot hang the lock past 5 s.
 *   4. Runs the caller's `fn` with the client.
 *   5. Commits on success; rolls back on throw; on Postgres
 *      SQLSTATE 40001 (serialization_failure) retries with jittered
 *      backoff up to `maxRetries` (default 3).
 *
 * The `client` passed to `fn` is the only way to write to Postgres.
 * It is released on return; the caller MUST NOT keep a reference.
 */
import type { PoolClient } from 'pg';
import type { Db } from './pool.js';
import { createDb } from './pool.js';

export interface UowOptions {
  /** Per-statement timeout inside the transaction, in ms. */
  readonly statementTimeoutMs?: number;
  /** Retry count on serialization failures (40001). */
  readonly maxRetries?: number;
  /** Base backoff in ms; doubled per retry. */
  readonly backoffMs?: number;
}

export class UowRetryExhausted extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super(`UoW retries exhausted: ${(cause as Error).message ?? 'unknown'}`);
    this.name = 'UowRetryExhausted';
    this.cause = cause;
  }
}

const DEFAULT_STATEMENT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 10;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` inside a single SERIALIZABLE transaction. The function
 * receives the active client; commit happens on return, rollback on
 * throw. Retries 40001 with exponential backoff + jitter.
 *
 * @param fn - The work. Must not cache the client outside the call.
 */
export async function runInTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
  options: UowOptions = {},
  db: Db = createDb(),
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const stmtTimeout = options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
      await client.query(`SET statement_timeout = ${stmtTimeout}`);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ROLLBACK may itself fail; swallow because we are already in
        // an error path and the connection is about to be released.
      }
      const code = (e as { code?: string }).code;
      if (code === '40001' && attempt < maxRetries) {
        // Serialization failure; retry with jitter.
        const wait = backoffMs * 2 ** attempt + Math.random() * backoffMs;
        lastErr = e;
        await sleep(wait);
        continue;
      }
      throw e;
    } finally {
      client.release();
    }
  }
  throw new UowRetryExhausted(lastErr);
}
