/**
 * Verified X link service tests (M7 #9).
 *
 * Covers: startXLink returns a valid authorization URL with
 * code_challenge + state, completeXLink exchanges the code +
 * persists handle + avatar, state mismatch refused, double
 * verify refused, getXLink returns the verified link, PKCE
 * code_verifier is 43-128 chars.
 */
import { Pool } from 'pg';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { config as loadDotenv } from 'dotenv';

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { NotFoundError, ValidationFailedError } from '../shared/domain/errors.js';
import { completeXLink, getXLink, startXLink, XClient } from './x-link.js';

loadDotenv({ path: process.cwd() + '/.env' });

_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function newUser(): Promise<string> {
  const id = uuidv7();
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [id, `xUser-${id}`]);
  return id;
}

function makeStubXClient(xUserId: string, xHandle: string, xAvatarUrl: string): XClient {
  return {
    async exchangeCode() {
      return { accessToken: 'stub-access', refreshToken: 'stub-refresh' };
    },
    async fetchMe() {
      return { xUserId, xHandle, xAvatarUrl };
    },
  };
}

beforeAll(async () => {
  await pool.query(`DELETE FROM x_links`);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query(
    `DELETE FROM x_links WHERE user_id IN (SELECT id FROM users WHERE wallet LIKE 'xUser-%')`,
  );
});

describe('x-link (verified X)', () => {
  it('startXLink returns a valid authorization URL', async () => {
    const ctx = buildContext();
    const u = await newUser();
    const r = await startXLink(ctx, u);
    expect(r.authorizationUrl).toMatch(/^https?:\/\//);
    expect(r.authorizationUrl).toContain('response_type=code');
    expect(r.authorizationUrl).toContain('code_challenge=');
    expect(r.authorizationUrl).toContain('code_challenge_method=S256');
    expect(r.state.length).toBeGreaterThanOrEqual(16);
  });

  it('startXLink persists code_verifier + state in x_links', async () => {
    const ctx = buildContext();
    const u = await newUser();
    const r = await startXLink(ctx, u);
    const row = await pool.query<{
      code_verifier: string;
      state: string;
      verified_at: Date | null;
    }>(`SELECT code_verifier, state, verified_at FROM x_links WHERE user_id = $1`, [u]);
    expect(row.rows[0]?.code_verifier.length).toBeGreaterThanOrEqual(43);
    expect(row.rows[0]?.state).toBe(r.state);
    expect(row.rows[0]?.verified_at).toBeNull();
  });

  it('startXLink is idempotent on re-call (overwrites in-flight row)', async () => {
    const ctx = buildContext();
    const u = await newUser();
    const first = await startXLink(ctx, u);
    const second = await startXLink(ctx, u);
    expect(second.state).not.toBe(first.state);
  });

  it('completeXLink exchanges the code + persists handle + avatar', async () => {
    const ctx = buildContext();
    const u = await newUser();
    const start = await startXLink(ctx, u);
    const client = makeStubXClient('12345', 'ctlife_test', 'https://x.com/avatar.png');
    const r = await completeXLink(ctx, u, 'auth-code-from-x', start.state, client);
    expect(r.xUserId).toBe('12345');
    expect(r.xHandle).toBe('ctlife_test');
    expect(r.xAvatarUrl).toBe('https://x.com/avatar.png');
    expect(r.verifiedAt).not.toBeNull();
  });

  it('completeXLink stores the access + refresh token as SHA-256 hashes', async () => {
    const ctx = buildContext();
    const u = await newUser();
    const start = await startXLink(ctx, u);
    const client = makeStubXClient('999', 'h', 'https://x.com/a.png');
    await completeXLink(ctx, u, 'auth-code', start.state, client);
    const r = await pool.query<{ access_token_hash: string; refresh_token_hash: string }>(
      `SELECT access_token_hash, refresh_token_hash FROM x_links WHERE user_id = $1`,
      [u],
    );
    const expectedAccess = createHash('sha256').update('stub-access').digest('base64');
    const expectedRefresh = createHash('sha256').update('stub-refresh').digest('base64');
    expect(r.rows[0]?.access_token_hash).toBe(expectedAccess);
    expect(r.rows[0]?.refresh_token_hash).toBe(expectedRefresh);
  });

  it('completeXLink refuses a state mismatch', async () => {
    const ctx = buildContext();
    const u = await newUser();
    await startXLink(ctx, u);
    const client = makeStubXClient('1', 'h', '');
    await expect(completeXLink(ctx, u, 'code', 'wrong-state', client)).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
  });

  it('completeXLink refuses a second verify', async () => {
    const ctx = buildContext();
    const u = await newUser();
    const start = await startXLink(ctx, u);
    const client = makeStubXClient('1', 'h', '');
    await completeXLink(ctx, u, 'code', start.state, client);
    await expect(completeXLink(ctx, u, 'code', start.state, client)).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
  });

  it('completeXLink throws NotFoundError for unknown user', async () => {
    const ctx = buildContext();
    const u = uuidv7();
    const client = makeStubXClient('1', 'h', '');
    await expect(completeXLink(ctx, u, 'code', 'state', client)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('getXLink returns null before verification', async () => {
    const ctx = buildContext();
    const u = await newUser();
    await startXLink(ctx, u);
    const r = await getXLink(ctx, u);
    expect(r).toBeNull();
  });

  it('getXLink returns the verified link after completeXLink', async () => {
    const ctx = buildContext();
    const u = await newUser();
    const start = await startXLink(ctx, u);
    await completeXLink(ctx, u, 'code', start.state, makeStubXClient('77', 'h', 'a'));
    const r = await getXLink(ctx, u);
    expect(r?.xUserId).toBe('77');
    expect(r?.xHandle).toBe('h');
  });
});
