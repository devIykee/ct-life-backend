/**
 * Dubai Marina + Cabal Lounge gating service tests (M7 #7).
 *
 * Covers: marinaVisit admission with sufficient net worth,
 * refusal below the gate, sybil-jailed refusal, non-marina
 * home refused, Cabal invite create + accept, host cannot
 * accept own invite, double-accept refused, expired invite
 * refused, listCabalInvites with hostId/guestId/used filter.
 */
import { Pool } from 'pg';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config as loadDotenv } from 'dotenv';

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { ForbiddenError, NotFoundError, ValidationFailedError } from '../shared/domain/errors.js';
import {
  acceptCabalInvite,
  createCabalInvite,
  listCabalInvites,
  marinaVisit,
  MARINA_GATE_CENTS,
} from './venues-gating.js';

loadDotenv({ path: process.cwd() + '/.env' });

_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function newUser(prefix: string): Promise<string> {
  const id = uuidv7();
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [
    id,
    `venuesUser-${prefix}-${id}`,
  ]);
  return id;
}

async function setBalance(userId: string, cashCents: number, debtCents = 0): Promise<void> {
  await pool.query(
    `INSERT INTO balances (user_id, cash_cents, debt_cents) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET cash_cents = $2, debt_cents = $3`,
    [userId, cashCents, debtCents],
  );
}

beforeAll(async () => {
  await pool.query(`DELETE FROM cabal_invites`);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query(
    `DELETE FROM cabal_invites WHERE host_user_id IN (SELECT id FROM users WHERE wallet LIKE 'venuesUser-%') OR guest_user_id IN (SELECT id FROM users WHERE wallet LIKE 'venuesUser-%')`,
  );
  await pool.query(
    `UPDATE users SET is_sybil_jailed = false, sybil_jailed_at = NULL
     WHERE wallet LIKE 'venuesUser-%'`,
  );
});

describe('venues gating (Dubai Marina + Cabal)', () => {
  it('marinaVisit admits a user with sufficient net worth', async () => {
    const ctx = buildContext();
    const u = await newUser('rich');
    await setBalance(u, MARINA_GATE_CENTS);
    const r = await marinaVisit(ctx, u, 'marina_villa');
    expect(r.admitted).toBe(true);
    expect(r.homeId).toBe('marina_villa');
    expect(r.userId).toBe(u);
  });

  it('marinaVisit refuses a user below the gate', async () => {
    const ctx = buildContext();
    const u = await newUser('poor');
    await setBalance(u, MARINA_GATE_CENTS - 1);
    await expect(marinaVisit(ctx, u, 'marina_villa')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('marinaVisit refuses a sybil-jailed user', async () => {
    const ctx = buildContext();
    const u = await newUser('jailed');
    await setBalance(u, MARINA_GATE_CENTS);
    await pool.query(`UPDATE users SET is_sybil_jailed = true WHERE id = $1`, [u]);
    await expect(marinaVisit(ctx, u, 'marina_villa')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('marinaVisit refuses a non-marina home', async () => {
    const ctx = buildContext();
    const u = await newUser('studio');
    await setBalance(u, MARINA_GATE_CENTS);
    await expect(marinaVisit(ctx, u, 'studio')).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('createCabalInvite + acceptCabalInvite happy path', async () => {
    const ctx = buildContext();
    const host = await newUser('host');
    const guest = await newUser('guest');
    const inv = await createCabalInvite(ctx, host);
    expect(inv.hostUserId).toBe(host);
    expect(inv.guestUserId).toBeNull();
    expect(inv.code.length).toBeGreaterThanOrEqual(16);
    const accepted = await acceptCabalInvite(ctx, guest, inv.inviteId);
    expect(accepted.guestUserId).toBe(guest);
    expect(accepted.usedAt).not.toBeNull();
  });

  it('acceptCabalInvite refuses the host accepting their own invite', async () => {
    const ctx = buildContext();
    const host = await newUser('self');
    const inv = await createCabalInvite(ctx, host);
    await expect(acceptCabalInvite(ctx, host, inv.inviteId)).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
  });

  it('acceptCabalInvite refuses a second accept (single-use)', async () => {
    const ctx = buildContext();
    const host = await newUser('h2');
    const guest1 = await newUser('g2a');
    const guest2 = await newUser('g2b');
    const inv = await createCabalInvite(ctx, host);
    await acceptCabalInvite(ctx, guest1, inv.inviteId);
    await expect(acceptCabalInvite(ctx, guest2, inv.inviteId)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('acceptCabalInvite refuses an expired invite', async () => {
    const ctx = buildContext();
    const host = await newUser('h3');
    const guest = await newUser('g3');
    const inv = await createCabalInvite(ctx, host);
    // Backdate the invite to 30 days ago.
    await pool.query(
      `UPDATE cabal_invites SET expires_at = now() - interval '30 days'
       WHERE invite_id = $1`,
      [inv.inviteId],
    );
    await expect(acceptCabalInvite(ctx, guest, inv.inviteId)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('acceptCabalInvite throws NotFoundError on unknown invite', async () => {
    const ctx = buildContext();
    const guest = await newUser('g4');
    await expect(acceptCabalInvite(ctx, guest, uuidv7())).rejects.toBeInstanceOf(NotFoundError);
  });

  it('listCabalInvites filters by hostId and used', async () => {
    const ctx = buildContext();
    const host = await newUser('h5');
    const guest = await newUser('g5');
    const inv1 = await createCabalInvite(ctx, host);
    const inv2 = await createCabalInvite(ctx, host);
    await acceptCabalInvite(ctx, guest, inv1.inviteId);
    const used = await listCabalInvites(ctx, { hostUserId: host, used: true });
    expect(used.length).toBe(1);
    expect(used[0]!.inviteId).toBe(inv1.inviteId);
    const unused = await listCabalInvites(ctx, { hostUserId: host, used: false });
    expect(unused.length).toBe(1);
    expect(unused[0]!.inviteId).toBe(inv2.inviteId);
  });

  it('listCabalInvites rejects bad limit', async () => {
    const ctx = buildContext();
    await expect(listCabalInvites(ctx, {}, 0)).rejects.toBeInstanceOf(ValidationFailedError);
  });
});
