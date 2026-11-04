/** Wallet identity proofs. Never transaction signatures or spending permissions. */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { getAddress, verifyMessage, type Address, type Hex } from 'viem';
import { createSiweMessage } from 'viem/siwe';
import { DomainError, ValidationFailedError } from '../shared/domain/errors.js';

export const WALLET_LINK_NETWORKS = ['eip155:4663', 'near:mainnet', 'solana:mainnet'] as const;
export type WalletLinkNetwork = (typeof WALLET_LINK_NETWORKS)[number];
export type WalletLinkProofScheme = 'eip4361-eoa' | 'nep413-ed25519' | 'solana-ed25519';

export class WalletLinkError extends DomainError {
  readonly code: string;
  /** Expose a stable, non-sensitive wallet-link failure at the API boundary. */
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.httpStatus = status;
  }
}

export interface WalletLinkChallenge {
  id: string;
  userId: string;
  network: WalletLinkNetwork;
  address: string;
  proofScheme: WalletLinkProofScheme;
  nonce: string;
  message: string;
  domain: string;
  uri: string;
  origin: string | null;
  issuedAt: string;
  expiresAt: string;
}

export interface WalletLinkProof {
  /** Hex for EVM, canonical base64 for Solana/NEAR. Signs the server message unchanged. */
  signature: string;
  /** Required only for NEAR. The account is bound in the challenge, not chosen here. */
  publicKey?: string;
}

/** Canonical identity key; reject malformed or unsupported account encodings. */
export function normalizeWalletLinkAddress(network: WalletLinkNetwork, address: string): string {
  try {
    if (network === 'eip155:4663') return getAddress(address).toLowerCase();
    if (network === 'solana:mainnet') {
      const key = new PublicKey(address);
      if (key.toBase58() !== address || !PublicKey.isOnCurve(key.toBytes())) throw new Error();
      return address;
    }
    if (
      network === 'near:mainnet' &&
      address.length >= 2 &&
      address.length <= 64 &&
      /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(address)
    )
      return address;
  } catch {
    /* Map malformed addresses without returning library internals. */
  }
  throw new ValidationFailedError({ field: 'address', reason: 'invalid_wallet_address' });
}

/** Return the single proof scheme this foundation supports for each network. */
export function walletLinkProofScheme(network: WalletLinkNetwork): WalletLinkProofScheme {
  if (network === 'eip155:4663') return 'eip4361-eoa';
  if (network === 'near:mainnet') return 'nep413-ed25519';
  return 'solana-ed25519';
}

/** Construct the exact player-, purpose-, origin- and network-bound signing text. */
export function createWalletLinkMessage(c: Omit<WalletLinkChallenge, 'message'>): string {
  const statement = `Link this wallet to CT Life player ${c.userId}. Identity only; this does not authorize payments, transactions, withdrawals or account recovery.`;
  if (c.network === 'eip155:4663') {
    return createSiweMessage({
      address: getAddress(c.address),
      chainId: 4663,
      domain: c.domain,
      uri: c.uri,
      nonce: c.nonce,
      version: '1',
      issuedAt: new Date(c.issuedAt),
      expirationTime: new Date(c.expiresAt),
      requestId: c.id,
      statement,
      resources: [`urn:ctlife:player:${c.userId}`, 'urn:ctlife:purpose:wallet-link'],
    });
  }
  return `${c.domain} requests a CT Life wallet identity link.\n\n${statement}\n\nAccount: ${c.address}\nNetwork: ${c.network}\nURI: ${c.uri}\nRequest ID: ${c.id}\nNonce: ${c.nonce}\nIssued At: ${c.issuedAt}\nExpiration Time: ${c.expiresAt}`;
}

function signatureBytes(signature: string): Buffer {
  if (!/^[A-Za-z0-9+/]{86}==$/.test(signature)) throw new Error('Invalid signature encoding');
  const bytes = Buffer.from(signature, 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== signature)
    throw new Error('Invalid signature');
  return bytes;
}

function verifyEd25519(bytes: Uint8Array, key: PublicKey, signature: string): boolean {
  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.toBuffer()]),
    format: 'der',
    type: 'spki',
  });
  return verify(null, bytes, publicKey, signatureBytes(signature));
}

/** Exact NEP-413 Borsh payload, not a cryptographic implementation. */
export function serializeNep413(
  message: string,
  nonce: Uint8Array,
  recipient: string,
  callbackUrl: string,
): Buffer {
  if (nonce.length !== 32) throw new Error('NEP-413 nonce must be 32 bytes');
  const string = (value: string): Buffer => {
    const data = Buffer.from(value, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32LE(data.length);
    return Buffer.concat([length, data]);
  };
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(2 ** 31 + 413);
  return Buffer.concat([
    tag,
    string(message),
    nonce,
    string(recipient),
    Buffer.from([1]),
    string(callbackUrl),
  ]);
}

export type NearFullAccessVerifier = (accountId: string, publicKey: string) => Promise<boolean>;

/** Read-only mainnet RPC; fail closed on unavailable, wrong-network or malformed responses. */
export function createNearFullAccessVerifier(
  rpcUrl: string,
  fetcher: typeof fetch = fetch,
): NearFullAccessVerifier {
  return async (accountId, publicKey) => {
    try {
      const url = new URL(rpcUrl);
      if (url.protocol !== 'https:' || url.username || url.password) return false;
    } catch {
      return false;
    }
    const query = async (
      method: string,
      params: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => {
      const response = await fetcher(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'wallet-link', method, params }),
        signal: AbortSignal.timeout(5_000),
        redirect: 'error',
      });
      if (!response.ok) throw new Error('RPC unavailable');
      const body = (await response.json()) as {
        jsonrpc?: unknown;
        id?: unknown;
        error?: unknown;
        result?: Record<string, unknown>;
      };
      if (body.jsonrpc !== '2.0' || body.id !== 'wallet-link' || body.error || !body.result)
        throw new Error('Invalid RPC response');
      return body.result;
    };
    try {
      const [status, access] = await Promise.all([
        query('status', {}),
        query('query', {
          request_type: 'view_access_key',
          finality: 'final',
          account_id: accountId,
          public_key: publicKey,
        }),
      ]);
      const sync = status.sync_info as
        { syncing?: unknown; latest_block_time?: unknown } | undefined;
      const blockTime =
        typeof sync?.latest_block_time === 'string' ? Date.parse(sync.latest_block_time) : NaN;
      if (
        status.chain_id !== 'mainnet' ||
        sync?.syncing !== false ||
        !Number.isFinite(blockTime) ||
        Date.now() - blockTime > 120_000 ||
        blockTime > Date.now() + 30_000
      )
        return false;
      return (
        access.permission === 'FullAccess' &&
        Number.isSafeInteger(access.nonce) &&
        Number(access.nonce) >= 0 &&
        Number.isSafeInteger(access.block_height) &&
        Number(access.block_height) > 0 &&
        typeof access.block_hash === 'string' &&
        new PublicKey(access.block_hash).toBase58() === access.block_hash
      );
    } catch {
      return false;
    }
  };
}

/** EVM deliberately accepts EOAs only; ERC-1271/6492 requires a separate chain-aware verifier. */
export async function verifyWalletLinkProof(
  challenge: WalletLinkChallenge,
  proof: WalletLinkProof,
  nearFullAccess: NearFullAccessVerifier = async () => false,
): Promise<boolean> {
  try {
    if (challenge.proofScheme !== walletLinkProofScheme(challenge.network)) return false;
    if (challenge.network === 'eip155:4663') {
      if (proof.publicKey !== undefined || !/^0x[0-9a-fA-F]{130}$/.test(proof.signature))
        return false;
      return await verifyMessage({
        address: challenge.address as Address,
        message: challenge.message,
        signature: proof.signature as Hex,
      });
    }
    if (challenge.network === 'solana:mainnet') {
      if (proof.publicKey !== undefined) return false;
      return verifyEd25519(
        Buffer.from(challenge.message, 'utf8'),
        new PublicKey(challenge.address),
        proof.signature,
      );
    }
    if (!proof.publicKey?.startsWith('ed25519:')) return false;
    const key = new PublicKey(proof.publicKey.slice(8));
    if (`ed25519:${key.toBase58()}` !== proof.publicKey || !PublicKey.isOnCurve(key.toBytes()))
      return false;
    const payload = serializeNep413(
      challenge.message,
      Buffer.from(challenge.nonce, 'hex'),
      challenge.domain,
      challenge.uri,
    );
    const hash = createHash('sha256').update(payload).digest();
    if (!verifyEd25519(hash, key, proof.signature)) return false;
    return await nearFullAccess(challenge.address, proof.publicKey);
  } catch {
    return false;
  }
}
