/**
 * Application service registry.
 *
 * Composition root for the REST API. One object that the Fastify
 * server holds on `app.decorate('ctx', ctx)`. Every handler gets it
 * from `request.ctx` and reads services off it. No handler reads
 * `process.env` or constructs its own DB / Redis / Solana client.
 *
 * Layering:
 *
 *   - The repo and service modules live alongside this file and
 *     import from `server/shared` only.
 *   - Transport (server/api) is the only layer that imports from
 *     `server/application`. Domain never imports from here.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../shared/db/pool.js';
import { createDb } from '../shared/db/pool.js';
import type { RedisLayer } from '../shared/redis/client.js';
import { createRedis } from '../shared/redis/client.js';
import type { JwtIssuer } from '../shared/auth/jwt.js';
import { createJwtIssuer } from '../shared/auth/jwt.js';
import type { HeliusClient } from '../shared/solana/helius.js';
import { createHeliusClient } from '../shared/solana/helius.js';
import type { RedisIdempotencyStore } from '../shared/infra/idempotency.js';
import { RedisIdempotencyStore as RedisIdem } from '../shared/infra/idempotency.js';
import { loadConfig, type Config } from '../shared/config/config.js';
import type { LiveKitService } from './livekit.js';
import { createLiveKitService } from './livekit.js';
import type { S3 } from '../shared/s3/client.js';
import { createS3 } from '../shared/s3/client.js';

export interface AppContext {
  readonly config: Config;
  readonly db: Db;
  readonly redis: RedisLayer;
  readonly jwt: JwtIssuer;
  readonly helius: HeliusClient;
  readonly idempotency: RedisIdempotencyStore;
  readonly livekit: LiveKitService;
  readonly s3: S3;
  /** Bumped at process start; the realtime welcome message carries it. */
  readonly instanceId: string;
  /** Issued per sign-in attempt; the in-memory store. */
  readonly nonces: NonceStore;
  /** Config payloads (loaded once, hot-cached). */
  readonly configCache: ConfigCache;
}

let cached: AppContext | null = null;

/**
 *
 */
export function buildContext(): AppContext {
  if (cached !== null) return cached;
  const config = loadConfig();
  const db = createDb();
  const redis = createRedis();
  const ctx: AppContext = {
    config,
    db,
    redis,
    jwt: createJwtIssuer(),
    helius: createHeliusClient({
      url: config.helius.rpcUrlMainnet,
      apiKey: config.helius.apiKey,
    }),
    idempotency: new RedisIdem(redis.main),
    livekit: createLiveKitService(),
    s3: createS3(),
    instanceId: randomUUID(),
    nonces: new RedisNonceStore(redis), // B6: Use Redis-backed nonce store
    configCache: new ConfigCache(),
  };
  cached = ctx;
  return ctx;
}

/** Test-only: drop the cached context. */
export function _resetContextForTests(): void {
  cached = null;
}

// --- Nonce store (Redis-backed per B6) -----------------------------------

export interface NonceRecord {
  readonly nonce: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly wallet: string | null;
  readonly used: boolean;
}

export interface NonceStore {
  put(nonce: string, ttlMs: number, issuedAt?: Date, expiresAt?: Date): Promise<NonceRecord>;
  get(nonce: string): Promise<NonceRecord | null>;
  markUsed(nonce: string, wallet: string): Promise<boolean>;
}

const NONCE_TTL_MS = 5 * 60 * 1000;

// B6: Keep InMemoryNonceStore for tests
export class InMemoryNonceStore implements NonceStore {
  private readonly map = new Map<string, NonceRecord>();

  /**
   * Store a nonce so it can be looked up once during sign-in.
   * @param nonce - The nonce to store.
   * @param ttlMs - Lifetime in milliseconds, used when expiresAt is omitted.
   * @param issuedAt - Issue time. Defaults to now.
   * @param expiresAt - Expiry time. Defaults to now plus ttlMs.
   * @returns The stored nonce record.
   */
  async put(nonce: string, ttlMs: number, issuedAt?: Date, expiresAt?: Date): Promise<NonceRecord> {
    const now = Date.now();
    const rec: NonceRecord = {
      nonce,
      issuedAt: issuedAt ? issuedAt.getTime() : now,
      expiresAt: expiresAt ? expiresAt.getTime() : now + ttlMs,
      wallet: null,
      used: false,
    };
    this.map.set(nonce, rec);
    // Lazy cleanup.
    if (this.map.size > 10_000) {
      for (const [k, v] of this.map) {
        if (v.expiresAt < now) this.map.delete(k);
      }
    }
    return rec;
  }

  /**
   * Look up a nonce, dropping it if it has already expired.
   * @param nonce - The nonce to look up.
   * @returns The nonce record, or null when it is unknown or expired.
   */
  async get(nonce: string): Promise<NonceRecord | null> {
    const rec = this.map.get(nonce);
    if (!rec) return null;
    if (rec.expiresAt < Date.now()) {
      this.map.delete(nonce);
      return null;
    }
    return rec;
  }

  /**
   * Atomically burn a nonce and bind it to the wallet that used it.
   * @param nonce - The nonce to mark used.
   * @param wallet - The wallet address consuming the nonce.
   * @returns True when the nonce was live and is now burned, false when it was
   * unknown, already used, or expired.
   */
  async markUsed(nonce: string, wallet: string): Promise<boolean> {
    const rec = this.map.get(nonce);
    if (!rec || rec.used || rec.expiresAt < Date.now()) return false;
    this.map.set(nonce, { ...rec, used: true, wallet });
    return true;
  }
}

// B6: Redis-backed nonce store for production
class RedisNonceStore implements NonceStore {
  constructor(private readonly redis: RedisLayer) {}

  async put(nonce: string, ttlMs: number, issuedAt?: Date, expiresAt?: Date): Promise<NonceRecord> {
    const now = Date.now();
    const rec: NonceRecord = {
      nonce,
      issuedAt: issuedAt ? issuedAt.getTime() : now,
      expiresAt: expiresAt ? expiresAt.getTime() : now + ttlMs,
      wallet: null,
      used: false,
    };
    const key = `nonce:${nonce}`;
    await this.redis.main.set(key, JSON.stringify(rec), 'PX', ttlMs);
    return rec;
  }

  async get(nonce: string): Promise<NonceRecord | null> {
    const key = `nonce:${nonce}`;
    const data = await this.redis.main.get(key);
    if (!data) return null;
    const rec = JSON.parse(data) as NonceRecord;
    if (rec.expiresAt < Date.now()) {
      await this.redis.main.del(key);
      return null;
    }
    return rec;
  }

  async markUsed(nonce: string, wallet: string): Promise<boolean> {
    const key = `nonce:${nonce}`;
    const data = await this.redis.main.get(key);
    if (!data) return false;
    const rec = JSON.parse(data) as NonceRecord;
    if (rec.used || rec.expiresAt < Date.now()) return false;
    const updated = { ...rec, used: true, wallet };
    const ttl = rec.expiresAt - Date.now();
    if (ttl <= 0) return false;
    await this.redis.main.set(key, JSON.stringify(updated), 'PX', ttl);
    return true;
  }
}

// --- Config cache -----------------------------------------------------

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export class ConfigCache {
  private cache = new Map<string, { etag: string; value: unknown }>();

  /**
   * Read a JSON config or id file from `contract/config/` or
   * `contract/ids/`. Caches by ETag-like fingerprint so repeated
   * calls return the same parsed object.
   */
  load<T>(name: string): T {
    const cached = this.cache.get(name);
    const candidates = [
      join(REPO_ROOT, 'contract', 'config', `${name}.json`),
      join(REPO_ROOT, 'contract', 'ids', `${name}.json`),
    ];
    let raw = '';
    for (const path of candidates) {
      try {
        raw = readFileSync(path, 'utf8');
        break;
      } catch {
        // try next
      }
    }
    if (raw === '') {
      throw new Error(
        `Config file not found: ${name}.json (looked in contract/config and contract/ids)`,
      );
    }
    const value = JSON.parse(raw) as T;
    const etag = `W/"${Buffer.byteLength(raw)}-${hashShort(raw)}"`;
    if (cached && cached.etag === etag) {
      return cached.value as T;
    }
    this.cache.set(name, { etag, value });
    return value;
  }
}

function hashShort(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (h * 33) ^ s.charCodeAt(i);
  }
  return (h >>> 0).toString(16);
}

export { NONCE_TTL_MS };
