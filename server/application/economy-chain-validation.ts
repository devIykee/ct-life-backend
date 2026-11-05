/** Strict JSON boundary helpers shared only by the native payment adapters. */
import { DomainError } from '../shared/domain/errors.js';
import type { PaymentExpectation, PaymentEvidence, PaymentRejection } from './economy-chain.js';

/** Internal typed rejection, converted to the verifier's explicit result union. */
export class EvidenceFailure extends DomainError {
  readonly code = 'VALIDATION_FAILED';
  /** Carry only the stable rejection code across the untrusted RPC boundary. */
  constructor(readonly reason: PaymentRejection) {
    super('Payment evidence did not satisfy the expected transfer.', { reason });
    this.httpStatus = 422;
  }
}

/** Fail closed without including RPC payloads or endpoint credentials in errors. */
export function demand(
  condition: unknown,
  reason: PaymentRejection = 'malformed_evidence',
): asserts condition {
  if (!condition) throw new EvidenceFailure(reason);
}
/** Parse an RPC object without asserting an unchecked response type. */
export function object(value: unknown): Record<string, unknown> {
  demand(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
/** Parse a bounded JSON list. */
export function list(value: unknown): unknown[] {
  demand(Array.isArray(value) && value.length <= 20_000);
  return value;
}
/** Parse a canonical, nonnegative base-unit integer. */
export function decimal(value: unknown, reason: PaymentRejection = 'malformed_evidence'): bigint {
  demand(typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value), reason);
  return BigInt(value);
}
/** JSON numbers must not silently round integers. */
export function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
/** Parse a compact Ethereum JSON-RPC quantity. */
export function quantity(value: unknown): bigint {
  demand(typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/.test(value));
  return BigInt(value);
}
/** Parse a hash or address and normalize response casing, never input intent. */
export function hex(value: unknown, bytes: number): string {
  demand(typeof value === 'string' && new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value));
  return value.toLowerCase();
}
/** Decode bounded base58 payloads, rejecting noncanonical/invalid characters. */
export function base58(value: unknown, expectedBytes?: number): Buffer {
  demand(
    typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 2000 &&
      /^[1-9A-HJ-NP-Za-km-z]+$/.test(value),
  );
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const c of value) n = n * 58n + BigInt(alphabet.indexOf(c));
  let bytes =
    n === 0n
      ? Buffer.alloc(0)
      : Buffer.from(n.toString(16).padStart(Math.ceil(n.toString(16).length / 2) * 2, '0'), 'hex');
  bytes = Buffer.concat([Buffer.alloc(value.match(/^1*/)?.[0].length ?? 0), bytes]);
  demand(expectedBytes === undefined || bytes.length === expectedBytes);
  return bytes;
}
/** Assemble evidence only after the chain-specific checks have succeeded. */
export function evidence(
  e: PaymentExpectation,
  details: Pick<
    PaymentEvidence,
    'transactionId' | 'eventId' | 'blockId' | 'blockHeight' | 'blockTimestampMs' | 'reference'
  >,
): PaymentEvidence {
  return {
    chainId: e.chainId,
    assetId: e.assetId,
    payer: e.payer,
    recipient: e.recipient,
    amountBaseUnits: e.amountBaseUnits,
    ...details,
  };
}
