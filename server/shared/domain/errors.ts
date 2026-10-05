/**
 * Typed domain error hierarchy.
 *
 * Every business layer throws a `DomainError` (or subclass). The transport
 * layer maps it to a contract error code at exactly one place: the error
 * handler in `server/api/main.ts` (and the equivalent in realtime).
 *
 * No `throw new Error("…")` in business logic. Catch only at the boundary.
 */

export abstract class DomainError extends Error {
  abstract readonly code: string;
  httpStatus: number;
  readonly details: Record<string, unknown>;
  /**
   * @param message - Human-readable description.
   * @param details - Structured details for the API response (no PII).
   */
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = this.constructor.name;
    this.httpStatus = 500;
    this.details = details;
  }
}

// Auth -------------------------------------------------------------------

export class NonceInvalidError extends DomainError {
  readonly code = 'NONCE_INVALID';
  constructor(details: Record<string, unknown> = {}) {
    super('Nonce is missing, used, or expired.', details);
    this.httpStatus = 401;
  }
}

export class SignatureInvalidError extends DomainError {
  readonly code = 'SIGNATURE_INVALID';
  constructor(details: Record<string, unknown> = {}) {
    super('Ed25519 signature did not verify.', details);
    this.httpStatus = 401;
  }
}

export class TokenExpiredError extends DomainError {
  readonly code = 'TOKEN_EXPIRED';
  constructor(details: Record<string, unknown> = {}) {
    super('Access token expired; refresh.', details);
    this.httpStatus = 401;
  }
}

export class SGTAlreadyLinkedError extends DomainError {
  readonly code = 'SGT_ALREADY_LINKED';
  constructor(details: Record<string, unknown> = {}) {
    super('This Seeker Genesis Token is already linked to another account.', details);
    this.httpStatus = 409;
  }
}

// Requests ----------------------------------------------------------------

export class ValidationFailedError extends DomainError {
  readonly code = 'VALIDATION_FAILED';
  constructor(details: Record<string, unknown> = {}) {
    super('Request body or params failed validation.', details);
    this.httpStatus = 400;
  }
}

export class NotFoundError extends DomainError {
  readonly code = 'NOT_FOUND';
  constructor(details: Record<string, unknown> = {}) {
    super('Resource not found.', details);
    this.httpStatus = 404;
  }
}

export class ForbiddenError extends DomainError {
  readonly code = 'FORBIDDEN';
  constructor(details: Record<string, unknown> = {}) {
    super('Caller is not allowed to perform this action.', details);
    this.httpStatus = 403;
  }
}

export class BlockedError extends DomainError {
  readonly code = 'BLOCKED';
  constructor(details: Record<string, unknown> = {}) {
    super('You are blocked by this user.', details);
    this.httpStatus = 403;
  }
}

export class RateLimitedError extends DomainError {
  readonly code = 'RATE_LIMITED';
  readonly retryAfterMs: number | undefined;
  /**
   * @param retryAfterMs - Suggested wait before the client retries.
   * @param details - Structured details (e.g. retryAfterMs).
   */
  constructor(retryAfterMs: number | undefined, details: Record<string, unknown> = {}) {
    super('Rate limit exceeded; try again later.', { ...details, retryAfterMs });
    this.httpStatus = 429;
    this.retryAfterMs = retryAfterMs;
  }
}

// Economy -----------------------------------------------------------------

export class InsufficientCashError extends DomainError {
  readonly code = 'INSUFFICIENT_CASH';
  constructor(details: Record<string, unknown> = {}) {
    super('Cash balance is insufficient.', details);
    this.httpStatus = 402;
  }
}

export class LeverageNotAllowedError extends DomainError {
  readonly code = 'LEVERAGE_NOT_ALLOWED';
  constructor(details: Record<string, unknown> = {}) {
    super('Leverage exceeds the cap from your Trading skill and tribe.', details);
    this.httpStatus = 400;
  }
}

export class SlippageExceededError extends DomainError {
  readonly code = 'SLIPPAGE_EXCEEDED';
  constructor(details: Record<string, unknown> = {}) {
    super('Trade would execute at a worse price than your maxSlippageBps.', details);
    this.httpStatus = 400;
  }
}

export class ShiftNotFinishedError extends DomainError {
  readonly code = 'SHIFT_NOT_FINISHED';
  constructor(details: Record<string, unknown> = {}) {
    super('Shift cannot be completed before durationSec has elapsed.', details);
    this.httpStatus = 400;
  }
}

// Places / Spaces ---------------------------------------------------------

export class VenueFullError extends DomainError {
  readonly code = 'VENUE_FULL';
  constructor(details: Record<string, unknown> = {}) {
    super('All venue instances are at capacity; try again shortly.', details);
    this.httpStatus = 503;
  }
}

export class SpotTakenError extends DomainError {
  readonly code = 'SPOT_TAKEN';
  constructor(details: Record<string, unknown> = {}) {
    super('Spot is taken.', details);
    this.httpStatus = 409;
  }
}

export class NotSpaceHostError extends DomainError {
  readonly code = 'NOT_SPACE_HOST';
  constructor(details: Record<string, unknown> = {}) {
    super('Only the space host can do this.', details);
    this.httpStatus = 403;
  }
}

// Payments ----------------------------------------------------------------

export class TopupCapReachedError extends DomainError {
  readonly code = 'TOPUP_CAP_REACHED';
  constructor(details: Record<string, unknown> = {}) {
    super('100 USDC of top-ups per wallet per day exceeded.', details);
    this.httpStatus = 429;
  }
}

export class PaymentExpiredError extends DomainError {
  readonly code = 'PAYMENT_EXPIRED';
  constructor(details: Record<string, unknown> = {}) {
    super('Payment intent expired before it was confirmed.', details);
    this.httpStatus = 410;
  }
}

export class PaymentUnderpaidError extends DomainError {
  readonly code = 'PAYMENT_UNDERPAID';
  constructor(details: Record<string, unknown> = {}) {
    super('On-chain transfer was below the intent amount.', details);
    this.httpStatus = 402;
  }
}

// Capacity ----------------------------------------------------------------

export class ServerBusyError extends DomainError {
  readonly code = 'SERVER_BUSY';
  readonly retryAfterMs: number;
  /**
   * @param retryAfterMs - Suggested wait before the client retries.
   * @param details - Structured details.
   */
  constructor(retryAfterMs: number, details: Record<string, unknown> = {}) {
    super('Server is at capacity. Retry-After header carries the wait time.', details);
    this.httpStatus = 503;
    this.retryAfterMs = retryAfterMs;
  }
}

// Misc --------------------------------------------------------------------

export class AliasTakenError extends DomainError {
  readonly code = 'ALIAS_TAKEN';
  constructor(details: Record<string, unknown> = {}) {
    super('Alias is taken.', details);
    this.httpStatus = 409;
  }
}

export class AlreadyRolledError extends DomainError {
  readonly code = 'ALREADY_ROLLED';
  constructor(details: Record<string, unknown> = {}) {
    super('Birth lottery has already been rolled for this account.', details);
    this.httpStatus = 409;
  }
}

export class ClientOutdatedError extends DomainError {
  readonly code = 'CLIENT_OUTDATED';
  readonly minClientVersion: string;
  /**
   * @param minClientVersion - The minimum required client version.
   * @param details - Structured details.
   */
  constructor(minClientVersion: string, details: Record<string, unknown> = {}) {
    super('Update required. X-Client-Version is below minClientVersion.', {
      ...details,
      minClientVersion,
    });
    this.httpStatus = 426;
    this.minClientVersion = minClientVersion;
  }
}

export class ConflictError extends DomainError {
  readonly code = 'CONFLICT';
  constructor(details: Record<string, unknown> = {}) {
    super('Resource conflict.', details);
    this.httpStatus = 409;
  }
}
