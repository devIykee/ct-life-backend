/**
 * Shared helpers for tools scripts. Kept tiny on purpose.
 */
import { config as loadDotenv } from 'dotenv';
import { createSolanaRpc } from '@solana/kit';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

loadDotenv({ path: resolve(process.cwd(), '.env') });

const envObj: Record<string, string | undefined> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (typeof v === 'string') envObj[k] = v;
}

export const env = {
  get DATABASE_URL(): string | undefined {
    return envObj.DATABASE_URL;
  },
  get REDIS_URL(): string | undefined {
    return envObj.REDIS_URL;
  },
  get SOLANA_RPC_URL_DEVNET(): string | undefined {
    return envObj.SOLANA_RPC_URL_DEVNET;
  },
  get SOLANA_RPC_URL_MAINNET(): string | undefined {
    return envObj.SOLANA_RPC_URL_MAINNET;
  },
  get HELIUS_API_KEY(): string | undefined {
    return envObj.HELIUS_API_KEY;
  },
  get HELIUS_RPC_URL_DEVNET(): string | undefined {
    return envObj.HELIUS_RPC_URL_DEVNET;
  },
  get HELIUS_RPC_URL_MAINNET(): string | undefined {
    return envObj.HELIUS_RPC_URL_MAINNET;
  },
  get LIVEKIT_URL(): string | undefined {
    return envObj.LIVEKIT_URL;
  },
  get LIVEKIT_API_KEY(): string | undefined {
    return envObj.LIVEKIT_API_KEY;
  },
  get LIVEKIT_API_SECRET(): string | undefined {
    return envObj.LIVEKIT_API_SECRET;
  },
  get S3_ENDPOINT(): string | undefined {
    return envObj.S3_ENDPOINT;
  },
  get ANTHROPIC_API_KEY(): string | undefined {
    return envObj.ANTHROPIC_API_KEY;
  },
  get APP_ENV(): string {
    return envObj.APP_ENV ?? 'local';
  },
  get NODE_ENV(): string {
    return envObj.NODE_ENV ?? 'development';
  },
};

/**
 * Create a Solana RPC client. Wraps `createSolanaRpc` so call sites can be
 * searched and mocked if needed.
 *
 * @param url - The full RPC URL (e.g. `https://api.devnet.solana.com`).
 * @returns The RPC client. Methods are bound to the returned object; each
 *          method returns a builder that must be `await ... .send()`-ed.
 */
export function createConnection(url: string): ReturnType<typeof createSolanaRpc> {
  return createSolanaRpc(url);
}

/** Re-exported type so consumers can pass RPC clients around. */
export type SolanaRpc = ReturnType<typeof createSolanaRpc>;

/**
 * Race a promise with a rejection after `ms`. The timer is always cleared,
 * even when the inner promise wins or throws.
 *
 * @param p - The promise to await.
 * @param ms - Timeout in milliseconds.
 * @param label - Used in the timeout error message.
 * @returns The resolved value of `p`.
 */
export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Read a file or return a default. */
export function readOr(file: string, fallback: string): string {
  if (!existsSync(file)) return fallback;
  return readFileSync(file, 'utf8');
}

/** Write a file, creating parent directories. */
export function writeFileEnsured(file: string, contents: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents, 'utf8');
}
