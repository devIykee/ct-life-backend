/**
 * Native payment preparation and finalized receipt verification. No signer, sender,
 * ambient configuration, price conversion, or entitlement mutation belongs here.
 * The caller must atomically claim (chainId, eventId) before granting an order.
 * EVM/NEAR transfers have no order memo: party/amount/time matching alone is NOT
 * replay protection. Only trusted, explicitly configured RPCs may implement this port.
 */
import { PublicKey } from '@solana/web3.js';
import { CapabilityOffError, ValidationFailedError } from '../shared/domain/errors.js';
import { prepareSolanaPayment, verifySolanaPayment } from './economy-chain-solana.js';
import { prepareEvmNearPayment, verifyEvmNearPayment } from './economy-chain-evm-near.js';
import { EvidenceFailure, demand, decimal, safeInteger } from './economy-chain-validation.js';

export type EconomyChainId = 'eip155:4663' | 'near:mainnet' | 'solana:mainnet';
export const ECONOMY_WIF = '0x5173b8ea6923c2d40267890d45c46a3480954773';
export const ECONOMY_ORE = 'oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp';
export const SOLANA_MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

export interface PaymentExpectation {
  readonly chainId: EconomyChainId;
  readonly assetId: string;
  readonly payer: string;
  readonly recipient: string;
  readonly amountBaseUnits: string;
  /** Exact signed Solana memo; not encoded into standard EVM/NEAR transfers. */
  readonly reference: string;
  /** Inclusive chain inclusion-time window, independent of polling time. */
  readonly notBeforeMs: number;
  readonly notAfterMs: number;
}

export interface PaymentEvidence {
  readonly chainId: EconomyChainId;
  readonly assetId: string;
  readonly payer: string;
  readonly recipient: string;
  readonly amountBaseUnits: string;
  readonly transactionId: string;
  /** Contains transaction ID plus log/instruction/receipt identity. */
  readonly eventId: string;
  readonly blockId: string;
  readonly blockHeight: string;
  readonly blockTimestampMs: number;
  readonly reference: string | null;
}

export type PaymentRejection =
  | 'invalid_expectation'
  | 'unsupported_asset'
  | 'network_mismatch'
  | 'malformed_evidence'
  | 'transaction_failed'
  | 'transfer_mismatch'
  | 'reference_mismatch'
  | 'ambiguous_transfer'
  | 'outside_window';
export type PaymentVerification =
  | { readonly state: 'verified'; readonly evidence: PaymentEvidence }
  | { readonly state: 'pending'; readonly reason: 'not_found' | 'not_finalized' }
  | { readonly state: 'rejected'; readonly reason: PaymentRejection };

export type PreparedPayment =
  | {
      readonly kind: 'solana';
      readonly chainId: 'solana:mainnet';
      readonly transactionBase64: string;
    }
  | {
      readonly kind: 'evm';
      readonly chainId: 'eip155:4663';
      readonly transaction: {
        readonly from: string;
        readonly to: string;
        readonly data: string;
        readonly value: string;
        readonly chainId: string;
      };
    }
  | {
      readonly kind: 'near';
      readonly chainId: 'near:mainnet';
      readonly signerId: string;
      readonly receiverId: string;
      readonly actions: readonly [
        { readonly type: 'Transfer'; readonly params: { readonly deposit: string } },
      ];
    };

export type EconomyRpc = (
  chainId: EconomyChainId,
  method: string,
  params: readonly unknown[] | Readonly<Record<string, unknown>>,
) => Promise<unknown>;

export interface EconomyChain {
  preparePayment(expectation: PaymentExpectation): Promise<PreparedPayment>;
  verifyPayment(
    expectation: PaymentExpectation,
    transactionId: string,
  ): Promise<PaymentVerification>;
}

/** Validate canonical addresses and allowlisted assets before any RPC operation. */
export function validatePaymentExpectation(e: PaymentExpectation): void {
  demand(e !== null && typeof e === 'object', 'invalid_expectation');
  demand(
    typeof e.reference === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(e.reference),
    'invalid_expectation',
  );
  demand(
    safeInteger(e.notBeforeMs) && safeInteger(e.notAfterMs) && e.notBeforeMs <= e.notAfterMs,
    'invalid_expectation',
  );
  const amount = decimal(e.amountBaseUnits, 'invalid_expectation');
  demand(amount > 0n && e.payer !== e.recipient, 'invalid_expectation');
  if (e.chainId === 'eip155:4663') {
    demand(e.assetId === ECONOMY_WIF, 'unsupported_asset');
    demand(
      /^0x[0-9a-f]{40}$/.test(e.payer) && /^0x[0-9a-f]{40}$/.test(e.recipient),
      'invalid_expectation',
    );
    demand(
      e.payer !== `0x${'0'.repeat(40)}` &&
        e.recipient !== `0x${'0'.repeat(40)}` &&
        amount < 1n << 256n,
      'invalid_expectation',
    );
  } else if (e.chainId === 'near:mainnet') {
    demand(e.assetId === 'native', 'unsupported_asset');
    const account = (s: string) =>
      typeof s === 'string' &&
      s.length >= 2 &&
      s.length <= 64 &&
      /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(s);
    demand(account(e.payer) && account(e.recipient) && amount < 1n << 128n, 'invalid_expectation');
  } else if (e.chainId === 'solana:mainnet') {
    demand(e.assetId === 'native' || e.assetId === ECONOMY_ORE, 'unsupported_asset');
    try {
      demand(
        new PublicKey(e.payer).toBase58() === e.payer &&
          new PublicKey(e.recipient).toBase58() === e.recipient,
        'invalid_expectation',
      );
      // The same direct-wallet adapter verifies refunds with the parties reversed.
      // Escrow/PDA senders need their own semantic verifier and are not enabled here.
      demand(
        PublicKey.isOnCurve(new PublicKey(e.payer).toBytes()) &&
          PublicKey.isOnCurve(new PublicKey(e.recipient).toBytes()),
        'invalid_expectation',
      );
    } catch {
      throw new EvidenceFailure('invalid_expectation');
    }
    demand(amount < 1n << 64n, 'invalid_expectation');
  } else {
    throw new EvidenceFailure('unsupported_asset');
  }
}

/** Create a stateless verifier; the RPC port must return JSON-RPC result values. */
export function createEconomyChain({ rpc }: { readonly rpc: EconomyRpc }): EconomyChain {
  const read: EconomyRpc = async (chain, method, params) => {
    try {
      return await rpc(chain, method, params);
    } catch {
      throw new CapabilityOffError({ reason: 'economy_rpc_unavailable', chainId: chain });
    }
  };
  return {
    async preparePayment(e) {
      try {
        validatePaymentExpectation(e);
        return e.chainId === 'solana:mainnet'
          ? await prepareSolanaPayment(read, e)
          : await prepareEvmNearPayment(read, e);
      } catch (err) {
        if (err instanceof EvidenceFailure) throw new ValidationFailedError({ reason: err.reason });
        throw err;
      }
    },
    async verifyPayment(e, transactionId) {
      try {
        validatePaymentExpectation(e);
        demand(
          typeof transactionId === 'string' &&
            transactionId.length > 0 &&
            transactionId.length <= 128,
        );
        const result =
          e.chainId === 'solana:mainnet'
            ? await verifySolanaPayment(read, e, transactionId)
            : await verifyEvmNearPayment(read, e, transactionId);
        if (result.state === 'verified') {
          demand(
            result.evidence.blockTimestampMs >= e.notBeforeMs &&
              result.evidence.blockTimestampMs <= e.notAfterMs,
            'outside_window',
          );
        }
        return result;
      } catch (err) {
        if (err instanceof EvidenceFailure) return { state: 'rejected', reason: err.reason };
        throw err;
      }
    },
  };
}
