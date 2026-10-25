/**
 * Writes a throwaway `.env` for CI (and for anyone who wants to run the test
 * suite without a hand-made one): `.env.example` plus freshly generated
 * secrets, nothing real. Keys and keypairs are random per run and written to
 * `.runtime/ci-keys/` (git-ignored).
 *
 * The test files load `<cwd>/.env` and need real key material for the HTTP
 * tests (JWT signing, devnet keypairs); this is what CI uses instead of a
 * developer's local `.env`.
 *
 * Run: tsx tools/scripts/ci-env.ts [--force]
 *   DATABASE_URL / REDIS_URL from the environment are copied in.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';

const root = process.cwd();
const envPath = join(root, '.env');
if (existsSync(envPath) && !process.argv.includes('--force')) {
  console.log('ci-env: .env exists, leaving it (use --force to overwrite)');
  process.exit(0);
}

const dir = join(root, '.runtime', 'ci-keys');
mkdirSync(dir, { recursive: true });
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
writeFileSync(join(dir, 'jwt-private.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
writeFileSync(join(dir, 'jwt-public.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
const keypair = (name: string): string => {
  const p = join(dir, `${name}.json`);
  writeFileSync(p, JSON.stringify(Array.from(Keypair.generate().secretKey)));
  return p;
};

const overrides: Record<string, string> = {
  APP_ENV: 'local',
  NODE_ENV: 'development',
  LOG_LEVEL: 'warn',
  JWT_PRIVATE_KEY: join(dir, 'jwt-private.pem'),
  JWT_PUBLIC_KEY: join(dir, 'jwt-public.pem'),
  TREASURY_PUBKEY_DEVNET: Keypair.generate().publicKey.toBase58(),
  SETTLE_AUTHORITY_KEYPAIR_DEVNET: keypair('settle'),
  ADMIN_KEYPAIR_DEVNET: keypair('admin'),
  HELIUS_API_KEY: 'ci-fake-helius-key',
  HELIUS_WEBHOOK_SECRET: randomBytes(24).toString('hex'),
  LIVEKIT_WEBHOOK_SECRET: randomBytes(24).toString('hex'),
  ENABLE_DEV_AUTH: 'true',
  ...(process.env.DATABASE_URL ? { DATABASE_URL: process.env.DATABASE_URL } : {}),
  ...(process.env.DATABASE_URL ? { TEST_DATABASE_URL: process.env.DATABASE_URL } : {}),
  ...(process.env.REDIS_URL ? { REDIS_URL: process.env.REDIS_URL } : {}),
};

const lines = readFileSync(join(root, '.env.example'), 'utf8').split('\n');
const seen = new Set<string>();
const out = lines.map((line) => {
  const m = /^([A-Z][A-Z0-9_]*)=/.exec(line);
  if (!m) return line;
  const key = m[1]!;
  if (key in overrides) {
    seen.add(key);
    return `${key}=${overrides[key]}`;
  }
  return line;
});
for (const [k, v] of Object.entries(overrides)) if (!seen.has(k)) out.push(`${k}=${v}`);
writeFileSync(envPath, out.join('\n') + '\n', { mode: 0o600 });
console.log(`ci-env: wrote .env (${Object.keys(overrides).length} values set)`);
