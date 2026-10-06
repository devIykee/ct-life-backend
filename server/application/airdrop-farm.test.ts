/**
 * Airdrop Farm + Sybil jail service tests (M7 #6).
 *
 * Covers: claimAirdrop happy path with base amount, idempotent
 * re-claim on the same day, sybil-jailed user is refused, SGT
 * bonus +50% on the amount, listAirdropClaims returns recent
 * claims, setSybilJailed / clearSybilJailed admin path.
 */
import { Pool } from 'pg';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config as loadDotenv } from 'dotenv';

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { ForbiddenError, NotFoundError } from '../shared/domain/errors.js';
import {
  claimAirdrop,
  clearSybilJailed,
  listAirdropClaims,
  setSybilJailed,
} from './airdrop-farm.js';

loadDotenv({ path: process.cwd() + '/.env' });

_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function newUser(prefix: string, sgtMint: string | null = null): Promise<string> {
  const id = uuidv7();
  await pool.query(
    `INSERT INTO users (id, wallet, sgt_mint) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET sgt_mint = EXCLUDED.sgt_mint`,
    [id, `airdropUser-${prefix}-${id}`, sgtMint],
  );
  return id;
}

async function getBalance(userId: string): Promise<number> {
  const r = await pool.query<{ cash_cents: string }>(
    `SELECT cash_cents FROM balances WHERE user_id = $1`,
    [userId],
  );
  return Number(r.rows[0]?.cash_cents ?? '0');
}

beforeAll(async () => {
  await pool.query(`DELETE FROM airdrop_claims`);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query(
    `DELETE FROM airdrop_claims WHERE user_id IN (SELECT id FROM users WHERE wallet LIKE 'airdropUser-%')`,
  );
  await pool.query(
    `DELETE FROM balances WHERE user_id IN (SELECT id FROM users WHERE wallet LIKE 'airdropUser-%')`,
  );
  // Reset sybil flag for test users.
  await pool.query(
    `UPDATE users SET is_sybil_jailed = false, sybil_jailed_at = NULL
     WHERE wallet LIKE 'airdropUser-%'`,
  );
});

describe('airdrop farm + sybil jail', () => {
  it('claimAirdrop credits the base amount on first claim', async () => {
    const ctx = buildContext();
    const u = await newUser('base');
    const cashBefore = await getBalance(u);
    const r = await claimAirdrop(ctx, u);
    expect(r.amountCents).toBe(500);
    expect(r.sgtBonus).toBe(false);
    expect(r.claimCount).toBe(1);
    expect(await getBalance(u)).toBe(cashBefore + 500);
  });

  it('claimAirdrop is idempotent on re-claim same day', async () => {
    const ctx = buildContext();
    const u = await newUser('idem');
    const first = await claimAirdrop(ctx, u);
    const second = await claimAirdrop(ctx, u);
    expect(second.claimId).toBe(first.claimId);
    expect(second.amountCents).toBe(first.amountCents);
    // The cash credit happens only once (the second call returns
    // the existing row).
    const r = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM airdrop_claims WHERE user_id = $1`,
      [u],
    );
    expect(Number(r.rows[0]?.count ?? '0')).toBe(1);
  });

  it('claimAirdrop with SGT applies +50% bonus', async () => {
    const ctx = buildContext();
    const u = await newUser('sgt', 'SGTmintAddress123');
    const r = await claimAirdrop(ctx, u);
    expect(r.sgtBonus).toBe(true);
    // 500 * 1.5 = 750
    expect(r.amountCents).toBe(750);
  });

  it('claimAirdrop refuses sybil-jailed user with ForbiddenError', async () => {
    const ctx = buildContext();
    const u = await newUser('jailed');
    await setSybilJailed(ctx, u);
    await expect(claimAirdrop(ctx, u)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('setSybilJailed / clearSybilJailed admin path', async () => {
    const ctx = buildContext();
    const u = await newUser('admin');
    const set = await setSybilJailed(ctx, u);
    expect(set.isSybilJailed).toBe(true);
    expect(set.sybilJailedAt).toMatch(/.+/);
    const cleared = await clearSybilJailed(ctx, u);
    expect(cleared.isSybilJailed).toBe(false);
  });

  it('claimAirdrop refuses unknown user with NotFoundError', async () => {
    const ctx = buildContext();
    await expect(claimAirdrop(ctx, uuidv7())).rejects.toBeInstanceOf(NotFoundError);
  });

  it('listAirdropClaims returns the caller recent claims', async () => {
    const ctx = buildContext();
    const u = await newUser('list');
    await claimAirdrop(ctx, u);
    const rows = await listAirdropClaims(ctx, u);
    expect(rows.length).toBe(1);
    expect(rows[0]!.userId).toBe(u);
  });

  it('listAirdropClaims rejects bad limit with ValidationFailedError', async () => {
    const ctx = buildContext();
    const u = await newUser('badlimit');
    await expect(listAirdropClaims(ctx, u, 0)).rejects.toBeInstanceOf(
      (await import('../shared/domain/errors.js')).ValidationFailedError,
    );
  });
});
