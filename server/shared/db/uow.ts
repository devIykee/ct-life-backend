/**
 * Unit of Work.
 *
 * The only module in the codebase that calls `BEGIN`, `COMMIT` or
 * `ROLLBACK`. Every service that mutates more than one row runs its
 * writes inside a UoW. The UoW:
 *
 *   1. Borrows a single client from the pool.
 *   2. Sets `ISOLATION LEVEL SERIALIZABLE` for the transaction (or READ
 *      COMMITTED when the caller holds its invariants with row locks; see
 *      UowOptions.isolation).
 *   3. Keeps the pool's 5 s `statement_timeout` (or sets a LOCAL one
 *      when the caller asks) so a single bad statement cannot hang the
 *      lock.
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
  /**
   * SERIALIZABLE by default. 'read committed' is only for transactions whose
   * every invariant is held by explicit row locks taken first (SELECT ...
   * FOR UPDATE on a per-player row): there SSI adds nothing but predicate
   * locks, and range reads over a busy table (the ledger) escalate them to
   * relation locks that fail unrelated transactions in bursts. Measured in
   * docs/LOAD-TEST.md.
   */
  readonly isolation?: 'serializable' | 'read committed';
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
      // One round trip to open the transaction. The pool already sets the
      // default statement timeout on every connection, so it is only set
      // here when the caller asks for a different one, and LOCAL so it ends
      // with the transaction instead of leaking onto the pooled connection.
      await client.query(
        options.isolation === 'read committed'
          ? 'BEGIN ISOLATION LEVEL READ COMMITTED'
          : 'BEGIN ISOLATION LEVEL SERIALIZABLE',
      );
      if (stmtTimeout !== DEFAULT_STATEMENT_TIMEOUT_MS) {
        await client.query(`SET LOCAL statement_timeout = ${Math.trunc(stmtTimeout)}`);
      }
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
      if (code !== '40001' || attempt >= maxRetries) throw e;
      lastErr = e;
    } finally {
      client.release();
    }
    // Serialization failure: back off with jitter, without holding a
    // pooled connection while we wait.
    await sleep(backoffMs * 2 ** attempt + Math.random() * backoffMs);
  }
  throw new UowRetryExhausted(lastErr);
}
