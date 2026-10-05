/**
 * Generates an Ed25519 Solana keypair (treasury, settle authority, admin).
 * Writes the keypair file under keypairs/ unless --stdout-only is passed.
 * The file is the standard Solana CLI JSON layout: an array of 64 numbers.
 * The public key is printed as hex. Use `solana-keygen pubkey <file>` or
 * the Wallet Adapter to convert to a base58 address.
 *
 * Usage:
 *   pnpm keygen treasury
 *   pnpm keygen settle-authority --stdout-only
 *   pnpm keygen admin
 */
import { writeFileEnsured, env } from './_lib';
import { resolve } from 'node:path';

const kind = process.argv[2] ?? '';

// Minimal local types for the webcrypto SubtleCrypto methods we use. The
// DOM `CryptoKey` / `CryptoKeyPair` are not in lib: ["ES2022"].
interface LocalKey {
  type: string;
  extractable: boolean;
  algorithm: { name: string };
  usages: string[];
}
interface LocalKeyPair {
  publicKey: LocalKey;
  privateKey: LocalKey;
}
const stdoutOnly = process.argv.includes('--stdout-only');

if (!['treasury', 'settle-authority', 'admin'].includes(kind)) {
  console.error('Usage: pnpm keygen <treasury|settle-authority|admin> [--stdout-only]');
  process.exit(2);
}

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

async function main(): Promise<void> {
  // Generate an Ed25519 keypair via webcrypto. We export the raw 32-byte
  // public key and the 32-byte private seed (last 32 bytes of the PKCS8
  // export), then combine them into the 64-byte Solana keypair layout
  // (the same one solana-keygen new writes to disk).
  const subtle = crypto.subtle as unknown as {
    generateKey: (algo: string, extractable: boolean, usages: string[]) => Promise<LocalKeyPair>;
    exportKey: (format: string, key: LocalKey) => Promise<ArrayBuffer>;
  };
  const kp = await subtle.generateKey('ed25519', true, ['sign', 'verify']);
  const publicRaw = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  const privateRaw = new Uint8Array(await subtle.exportKey('pkcs8', kp.privateKey));
  const seed = privateRaw.slice(-32);

  const fullSecret = new Uint8Array(64);
  fullSecret.set(publicRaw, 0);
  fullSecret.set(seed, 32);

  const publicHex = bytesToHex(publicRaw);

  if (stdoutOnly) {
    const out = {
      publicKeyHex: publicHex,
      secretKeyBytes: Array.from(fullSecret),
      cluster: env.APP_ENV === 'prod' ? 'mainnet' : 'devnet',
    };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const file = resolve(process.cwd(), 'keypairs', `${kind}-devnet.json`);
  const arr = Array.from(fullSecret);
  writeFileEnsured(file, JSON.stringify(arr));
  // eslint-disable-next-line no-console
  console.log(`Wrote ${file}`);
  // eslint-disable-next-line no-console
  console.log(`Public key (hex): ${publicHex}`);
  // eslint-disable-next-line no-console
  console.log(
    `Convert to base58 with: solana-keygen pubkey ${file}  (or use the seed .private JSON; see set -e TREASURY_PUBKEY in .env)`,
  );
}

void main();
