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

// Homes -------------------------------------------------------------------

export class NoFreeUnitError extends DomainError {
  readonly code = 'NO_FREE_UNIT';
  constructor(details: Record<string, unknown> = {}) {
    super('Every unit of this home tier is taken; try again later or pick another tier.', details);
    this.httpStatus = 409;
  }
}

export class NoHomeDoorError extends DomainError {
  readonly code = 'NO_HOME_DOOR';
  constructor(details: Record<string, unknown> = {}) {
    super('Delivery to the door needs a home with a door; pick the lobby locker.', details);
    this.httpStatus = 409;
  }
}

export class OrderNotCancellableError extends DomainError {
  readonly code = 'ORDER_NOT_CANCELLABLE';
  constructor(details: Record<string, unknown> = {}) {
    super('Only an order that is still placed can be cancelled.', details);
    this.httpStatus = 409;
  }
}

export class ItemNotOwnedError extends DomainError {
  readonly code = 'ITEM_NOT_OWNED';
  constructor(details: Record<string, unknown> = {}) {
    super('You do not own this item.', details);
    this.httpStatus = 403;
  }
}

export class ItemNotPlaceableError extends DomainError {
  readonly code = 'ITEM_NOT_PLACEABLE';
  constructor(details: Record<string, unknown> = {}) {
    super('This item cannot be placed in a home.', details);
    this.httpStatus = 409;
  }
}

export class ItemAlreadyPlacedError extends DomainError {
  readonly code = 'ITEM_ALREADY_PLACED';
  constructor(details: Record<string, unknown> = {}) {
    super('This item is already placed (in the request twice, or in another home).', details);
    this.httpStatus = 409;
  }
}

export class NotHomeOwnerError extends DomainError {
  readonly code = 'NOT_HOME_OWNER';
  constructor(details: Record<string, unknown> = {}) {
    super("Only the home's owner can do this.", details);
    this.httpStatus = 403;
  }
}

export class UnitFullError extends DomainError {
  readonly code = 'UNIT_FULL';
  constructor(details: Record<string, unknown> = {}) {
    super('The unit is at capacity; remove a guest first.', details);
    this.httpStatus = 409;
  }
}

export class FreezeLimitReachedError extends DomainError {
  readonly code = 'FREEZE_LIMIT_REACHED';
  constructor(details: Record<string, unknown> = {}) {
    super('You already hold the maximum number of streak freezes.', details);
    this.httpStatus = 409;
  }
}

export class PassRequiredError extends DomainError {
  readonly code = 'PASS_REQUIRED';
  constructor(details: Record<string, unknown> = {}) {
    super('The paid track needs an active season pass.', details);
    this.httpStatus = 403;
  }
}

export class TierLockedError extends DomainError {
  readonly code = 'TIER_LOCKED';
  constructor(details: Record<string, unknown> = {}) {
    super('Not enough Season XP for this tier yet.', details);
    this.httpStatus = 409;
  }
}

// Casino -------------------------------------------------------------------

export class AgeRequiredError extends DomainError {
  readonly code = 'AGE_REQUIRED';
  constructor(details: Record<string, unknown> = {}) {
    super('The Casino is 18+. Confirm your age to play.', details);
    this.httpStatus = 403;
  }
}

export class StakeCapReachedError extends DomainError {
  readonly code = 'STAKE_CAP_REACHED';
  constructor(details: Record<string, unknown> = {}) {
    super('This stake would pass your daily casino stake cap. Try again tomorrow (UTC).', details);
    this.httpStatus = 403;
  }
}

export class LossCapReachedError extends DomainError {
  readonly code = 'LOSS_CAP_REACHED';
  constructor(details: Record<string, unknown> = {}) {
    super(
      'This stake would pass your daily casino net-loss cap. Try again tomorrow (UTC).',
      details,
    );
    this.httpStatus = 403;
  }
}

export class SelfExcludedError extends DomainError {
  readonly code = 'SELF_EXCLUDED';
  constructor(details: Record<string, unknown> = {}) {
    super('You have excluded yourself from the casino until the date shown.', details);
    this.httpStatus = 403;
  }
}

export class RoundSettledError extends DomainError {
  readonly code = 'ROUND_SETTLED';
  constructor(details: Record<string, unknown> = {}) {
    super('This round is already settled.', details);
    this.httpStatus = 409;
  }
}

export class NodTooFarError extends DomainError {
  readonly code = 'NOD_TOO_FAR';
  constructor(details: Record<string, unknown> = {}) {
    super(
      "The server's last position for you is more than the collect radius from this nod.",
      details,
    );
    this.httpStatus = 409;
  }
}

export class QuestNotCompleteError extends DomainError {
  readonly code = 'QUEST_NOT_COMPLETE';
  constructor(details: Record<string, unknown> = {}) {
    super('This quest is not finished yet.', details);
    this.httpStatus = 409;
  }
}

export class RoundInProgressError extends DomainError {
  readonly code = 'ROUND_IN_PROGRESS';
  constructor(details: Record<string, unknown> = {}) {
    super('Finish your open crash round before starting another.', details);
    this.httpStatus = 409;
  }
}

export class ChallengeExpiredError extends DomainError {
  readonly code = 'CHALLENGE_EXPIRED';
  constructor(details: Record<string, unknown> = {}) {
    super('This challenge expired.', details);
    this.httpStatus = 410;
  }
}

export class ChallengeNotOpenError extends DomainError {
  readonly code = 'CHALLENGE_NOT_OPEN';
  constructor(details: Record<string, unknown> = {}) {
    super('This challenge is no longer open.', details);
    this.httpStatus = 409;
  }
}

export class PositionUnknownError extends DomainError {
  readonly code = 'POSITION_UNKNOWN';
  constructor(details: Record<string, unknown> = {}) {
    super('The server has no recent street position for the player.', details);
    this.httpStatus = 409;
  }
}

// Economy -----------------------------------------------------------------

function withShortfall(details: Record<string, unknown>): Record<string, unknown> {
  if ('shortfallCents' in details) return details;
  const { have, need } = details;
  if (
    (typeof have === 'string' || typeof have === 'number') &&
    (typeof need === 'string' || typeof need === 'number') &&
    /^-?\d+$/.test(String(have)) &&
    /^-?\d+$/.test(String(need))
  ) {
    const short = BigInt(String(need)) - BigInt(String(have));
    return { ...details, shortfallCents: Number(short > 0n ? short : 0n) };
  }
  return details;
}

export class InsufficientCashError extends DomainError {
  readonly code = 'INSUFFICIENT_CASH';
  /**
   * @param details - Structured details. When `have` and `need` (cents, as numbers or numeric
   * strings) are present, `shortfallCents` (need minus have, an integer number) is added: the
   * standard field clients should read. `have` and `need` stay for compatibility.
   */
  constructor(details: Record<string, unknown> = {}) {
    super('Cash balance is insufficient.', withShortfall(details));
    this.httpStatus = 402;
  }
}

export class NothingToRepayError extends DomainError {
  readonly code = 'NOTHING_TO_REPAY';
  constructor(details: Record<string, unknown> = {}) {
    super('There is no debt to repay.', details);
    this.httpStatus = 409;
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

/** Venue voice was asked for an instance the caller is not currently in. */
export class NotInVenueError extends DomainError {
  readonly code = 'NOT_IN_VENUE';
  constructor(details: Record<string, unknown> = {}) {
    super('You are not in that venue. Join it before connecting to its voice.', details);
    this.httpStatus = 403;
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

// Events ------------------------------------------------------------------

export class EventNotLiveError extends DomainError {
  readonly code = 'EVENT_NOT_LIVE';
  constructor(details: Record<string, unknown> = {}) {
    super('This event is not live; its quests only run inside its window.', details);
    this.httpStatus = 409;
  }
}

export class EventStepInvalidError extends DomainError {
  readonly code = 'EVENT_STEP_INVALID';
  constructor(details: Record<string, unknown> = {}) {
    super('That quest step or proof is not valid for this event.', details);
    this.httpStatus = 400;
  }
}

export class TriviaCooldownError extends DomainError {
  readonly code = 'TRIVIA_COOLDOWN';
  constructor(details: Record<string, unknown> = {}) {
    super(
      'That trivia question is cooling down after a wrong answer; try it again later.',
      details,
    );
    this.httpStatus = 429;
  }
}

// Rugpull Factory ---------------------------------------------------------

export class NameNotAllowedError extends DomainError {
  readonly code = 'NAME_NOT_ALLOWED';
  constructor(details: Record<string, unknown> = {}) {
    super('That coin name or ticker is not allowed.', details);
    this.httpStatus = 400;
  }
}

export class ContentNotAllowedError extends DomainError {
  readonly code = 'CONTENT_NOT_ALLOWED';
  /** @param details - `field` says which input was refused (alias, dm, post). */
  constructor(details: Record<string, unknown> = {}) {
    super('That text contains words that are not allowed.', details);
    this.httpStatus = 400;
  }
}

export class AccountMutedError extends DomainError {
  readonly code = 'ACCOUNT_MUTED';
  /** @param details - `until` is the ISO time the mute ends. */
  constructor(details: Record<string, unknown> = {}) {
    super('This account is muted and cannot send messages or posts right now.', details);
    this.httpStatus = 403;
  }
}

export class AccountBannedError extends DomainError {
  readonly code = 'ACCOUNT_BANNED';
  constructor(details: Record<string, unknown> = {}) {
    super('This account has been banned.', details);
    this.httpStatus = 403;
  }
}

export class CheckinRejectedError extends DomainError {
  readonly code = 'CHECKIN_REJECTED';
  /**
   * @param reason - Why: mock_location, poor_accuracy, outside_geofence,
   *   account_too_new or not_available. Never carries a position or distance.
   */
  constructor(reason: string) {
    super('The IRL check-in was not accepted.', { reason });
    this.httpStatus = 422;
  }
}

export class TickerTakenError extends DomainError {
  readonly code = 'TICKER_TAKEN';
  constructor(details: Record<string, unknown> = {}) {
    super('That ticker is already used by another coin.', details);
    this.httpStatus = 409;
  }
}

export class LaunchLimitReachedError extends DomainError {
  readonly code = 'LAUNCH_LIMIT_REACHED';
  constructor(details: Record<string, unknown> = {}) {
    super("You have reached today's coin launch limit.", details);
    this.httpStatus = 429;
  }
}

export class LaunchCooldownError extends DomainError {
  readonly code = 'LAUNCH_COOLDOWN';
  constructor(details: Record<string, unknown> = {}) {
    super('Wait before launching another coin.', details);
    this.httpStatus = 429;
  }
}

// Careers + Rekt Burger -----------------------------------------------------

export class CareerSwitchCooldownError extends DomainError {
  readonly code = 'CAREER_SWITCH_COOLDOWN';
  constructor(details: Record<string, unknown> = {}) {
    super('You switched career ladders recently; wait for the cooldown to end.', details);
    this.httpStatus = 409;
  }
}

export class JobLockedError extends DomainError {
  readonly code = 'JOB_LOCKED';
  constructor(details: Record<string, unknown> = {}) {
    super('This job is not unlocked for you.', details);
    this.httpStatus = 403;
  }
}

export class JobDailyCapError extends DomainError {
  readonly code = 'JOB_DAILY_CAP';
  constructor(details: Record<string, unknown> = {}) {
    super("You have earned today's maximum pay from this job.", details);
    this.httpStatus = 409;
  }
}

export class GoneError extends DomainError {
  readonly code = 'GONE';
  constructor(details: Record<string, unknown> = {}) {
    super('This endpoint was removed; see details.use for its replacement.', details);
    this.httpStatus = 410;
  }
}

export class CounterTooFarError extends DomainError {
  readonly code = 'COUNTER_TOO_FAR';
  constructor(details: Record<string, unknown> = {}) {
    super("The server's last position for you is too far from the McDonald's counter.", details);
    this.httpStatus = 409;
  }
}

// Cash is purchasable but not transferable ------------------------------------

export class CashNotTransferableError extends DomainError {
  readonly code = 'CASH_NOT_TRANSFERABLE';
  constructor(details: Record<string, unknown> = {}) {
    super(
      'Cash never moves between players. This feature was removed; see details.reason.',
      details,
    );
    this.httpStatus = 410;
  }
}

export class NftMintNotAllowedError extends DomainError {
  readonly code = 'NFT_MINT_NOT_ALLOWED';
  constructor(details: Record<string, unknown> = {}) {
    super('This item cannot be minted as an NFT: it was not acquired on-chain.', details);
    this.httpStatus = 403;
  }
}

// Sleuth heat, jail and police pursuit --------------------------------------

export class JailedError extends DomainError {
  readonly code = 'JAILED';
  constructor(details: Record<string, unknown> = {}) {
    super('You are in Jail. Pay bail or wait it out.', details);
    this.httpStatus = 403;
  }
}

export class NotJailedError extends DomainError {
  readonly code = 'NOT_JAILED';
  constructor(details: Record<string, unknown> = {}) {
    super('You are not in Jail.', details);
    this.httpStatus = 409;
  }
}

export class NoPursuitError extends DomainError {
  readonly code = 'NO_PURSUIT';
  constructor(details: Record<string, unknown> = {}) {
    super('There is no active police pursuit for you.', details);
    this.httpStatus = 409;
  }
}

export class CatchNotVerifiedError extends DomainError {
  readonly code = 'CATCH_NOT_VERIFIED';
  constructor(details: Record<string, unknown> = {}) {
    super('The server could not verify that the police caught you.', details);
    this.httpStatus = 422;
  }
}

export class FactoryCashRetiredError extends DomainError {
  readonly code = 'FACTORY_CASH_RETIRED';
  constructor(details: Record<string, unknown> = {}) {
    super('The Cash Factory is retired. Launch a real token instead.', details);
    this.httpStatus = 410;
  }
}

export class FactoryUnavailableError extends DomainError {
  readonly code = 'FACTORY_UNAVAILABLE';
  constructor(details: Record<string, unknown> = {}) {
    super('Real token launches are not configured on this server.', details);
    this.httpStatus = 503;
  }
}

export class LaunchExpiredError extends DomainError {
  readonly code = 'LAUNCH_EXPIRED';
  constructor(details: Record<string, unknown> = {}) {
    super('This launch expired (its blockhash is too old). Prepare a new one.', details);
    this.httpStatus = 409;
  }
}

export class LaunchTxMismatchError extends DomainError {
  readonly code = 'LAUNCH_TX_MISMATCH';
  constructor(details: Record<string, unknown> = {}) {
    super('The signed transaction is not the launch that was prepared.', details);
    this.httpStatus = 422;
  }
}

export class LaunchNotConfirmedError extends DomainError {
  readonly code = 'LAUNCH_NOT_CONFIRMED';
  constructor(details: Record<string, unknown> = {}) {
    super('The launch transaction is not confirmed on chain (yet).', details);
    this.httpStatus = 409;
  }
}

export class RiskNotAcceptedError extends DomainError {
  readonly code = 'RISK_NOT_ACCEPTED';
  constructor(details: Record<string, unknown> = {}) {
    super('Accept the risk warning before launching a real token.', details);
    this.httpStatus = 400;
  }
}

export class CapabilityOffError extends DomainError {
  readonly code = 'CAPABILITY_OFF';
  constructor(details: Record<string, unknown> = {}) {
    super('This feature is not turned on on this server yet.', details);
    this.httpStatus = 503;
  }
}

export class HomeClosedError extends DomainError {
  readonly code = 'HOME_CLOSED';
  constructor(details: Record<string, unknown> = {}) {
    super('This home is closed to visitors.', details);
    this.httpStatus = 403;
  }
}
