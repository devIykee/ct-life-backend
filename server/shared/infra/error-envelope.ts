/**
 * Contract error envelope.
 *
 * The contract says every REST error response is shaped as:
 *
 *   { "error": { "code": "<CODE>", "message": "<human-readable>", "details": { ... } } }
 *
 * with an HTTP status matching the code. The error codes are listed in
 * contract/ids/errors.json and matched in the typed DomainError
 * hierarchy in server/shared/domain/errors.ts.
 *
 * This module is the single mapping from a DomainError (thrown by
 * business code) to the contract envelope. The Fastify error handler
 * imports `toErrorEnvelope` and uses it for every DomainError; the
 * realtime rejection mapper uses it for the `rejected` message.
 *
 * Layering: this is a transport concern. It is in server/shared/infra
 * so both the API and the realtime rooms can use the same mapping.
 */
import { DomainError } from '../domain/errors.js';

export interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details: Record<string, unknown>;
  };
}

export interface MappedError {
  readonly status: number;
  readonly envelope: ErrorEnvelope;
  readonly headers: Record<string, string>;
}

/**
 * Convert a DomainError (or an unknown throw) to the contract error
 * envelope and an HTTP status. Unknown errors become INTERNAL_ERROR
 * with status 500 and no details (the original message is logged but
 * not returned to the client).
 */
export function toErrorEnvelope(
  err: unknown,
  logger?: { error(msg: string, extra?: unknown): void },
): MappedError {
  if (err instanceof DomainError) {
    const headers: Record<string, string> = {};
    if (err.code === 'RATE_LIMITED' && 'retryAfterMs' in err) {
      const r = (err as { retryAfterMs?: number }).retryAfterMs;
      if (r !== undefined) headers['Retry-After'] = String(Math.ceil(r / 1000));
    }
    if (err.code === 'SERVER_BUSY' && 'retryAfterMs' in err) {
      const r = (err as { retryAfterMs?: number }).retryAfterMs;
      if (r !== undefined) headers['Retry-After'] = String(Math.ceil(r / 1000));
    }
    if (err.code === 'TOKEN_EXPIRED' || err.code === 'SIGNATURE_INVALID') {
      headers['WWW-Authenticate'] = 'Bearer';
    }
    return {
      status: err.httpStatus,
      envelope: {
        error: {
          code: err.code,
          message: err.message,
          details: err.details,
        },
      },
      headers,
    };
  }
  if (logger) {
    logger.error('unhandled error', { err: (err as Error)?.message ?? String(err) });
  }
  return {
    status: 500,
    envelope: {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error.',
        details: {},
      },
    },
    headers: {},
  };
}
