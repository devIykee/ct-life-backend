/**
 * Solana keypair loader.
 *
 * Accepts either a filesystem path to a Solana CLI JSON keypair (the
 * standard `[number, number, …, number]` 64-element array layout) or
 * a base58-encoded 64-byte secret key. The config layer stores one of
 * those two formats per variable (SETTLE_AUTHORITY_KEYPAIR, ADMIN_KEYPAIR,
 * TREASURY_PUBKEY). The loader returns a `CryptoKey` for use with
 * @solana/kit's signer or the legacy ed25519 verify path.
 *
 * The treasury is a public key only; we never load its private key.
 */
import { readFileSync } from 'node:fs';
import { Keypair, PublicKey } from '@solana/web3.js';
import { createHash } from 'node:crypto';

export type LoadedKeypair =
  | { kind: 'json-file'; path: string; keypair: Keypair }
  | { kind: 'base58'; value: string; keypair: Keypair };

/** Loads a keypair from either a JSON file or a base58 64-byte secret. */
export function loadKeypair(input: string): LoadedKeypair {
  // File path: starts with '/' or './' or contains '.json' and exists on disk.
  if (input.startsWith('/') || input.startsWith('./') || input.endsWith('.json')) {
    try {
      const raw = readFileSync(input, 'utf8');
      const arr = JSON.parse(raw) as number[];
      if (!Array.isArray(arr) || arr.length !== 64) {
        throw new Error(`Expected 64-byte array, got length ${arr.length}`);
      }
      return {
        kind: 'json-file',
        path: input,
        keypair: Keypair.fromSecretKey(Uint8Array.from(arr)),
      };
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') {
        // Fall through to base58 path.
      } else {
        throw new Error(`Keypair load failed for ${input}: ${(e as Error).message}`);
      }
    }
  }
  // Base58.
  try {
    const decoded = base58Decode(input);
    if (decoded.length !== 64) {
      throw new Error(`Base58 decoded length is ${decoded.length}, expected 64`);
    }
    return { kind: 'base58', value: input, keypair: Keypair.fromSecretKey(decoded) };
  } catch (e) {
    throw new Error(`Keypair load failed (base58): ${(e as Error).message}`);
  }
}

/** Validates a base58 Solana public key and returns it. Throws on garbage. */
export function loadPublicKey(input: string): PublicKey {
  try {
    return new PublicKey(input);
  } catch {
    throw new Error(`Invalid Solana public key: ${input}`);
  }
}

/**
 * Base58 decode (Bitcoin alphabet). Used for the alternative layout of
 * Solana secret keys and for the 32-byte ed25519 seed embedded in the
 * standard 64-byte layout.
 */
export function base58Decode(s: string): Uint8Array {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  if (s.length === 0) return new Uint8Array(0);
  // Convert each character to its base58 digit.
  const bytes: number[] = [];
  for (const ch of s) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`Invalid base58 character: ${ch}`);
    let carry = idx;
    for (let i = 0; i < bytes.length; i++) {
      const cur = bytes[i];
      if (cur === undefined) continue;
      const v = cur * 58 + carry;
      bytes[i] = v & 0xff;
      carry = v >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of s) {
    if (ch === '1') bytes.push(0);
    else break;
  }
  return Uint8Array.from(bytes.reverse());
}

/** Hash a wallet for use as a rate-limit key without storing the wallet. */
export function walletHash(wallet: string): string {
  return createHash('sha256').update(wallet).digest('hex');
}
