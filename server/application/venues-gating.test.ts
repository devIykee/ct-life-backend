/**
 * Dubai Marina + Cabal Lounge gating service tests (M7 #7).
 *
 * Covers: marinaVisit admission with sufficient net worth,
 * refusal below the gate, sybil-jailed refusal, non-marina
 * home refused, Cabal invite create + accept, host cannot
 * accept own invite, double-accept refused, expired invite
 * refused, listCabalInvites with hostId/guestId/used filter.
 * Unlock A3: host gate and cap, targeted invites (only the guest may
 * accept, blocks, duplicates, members), revoke, derived status and the
 * code shown only to the host.
 */
import { Pool } from 'pg';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config as loadDotenv } from 'dotenv';

import { buildContext, _resetContextForTests } from './context.js';
import { subscribeUserMessages, type UserMessage } from './realtime-bus.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import {
  BlockedError,
  ConflictError,
  ForbiddenError,
  NetWorthTooLowError,
  NotFoundError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import {
  acceptCabalInvite,
  createCabalInvite,
  CABAL_INVITES_PER_HOST,
  getMyCabal,
  listCabalInvites,
  marinaVisit,
  MARINA_GATE_CENTS,
  revokeCabalInvite,
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
    await setBalance(host, MARINA_GATE_CENTS);
    const guest = await newUser('guest');
    const inv = await createCabalInvite(ctx, host);
    expect(inv.hostUserId).toBe(host);
    expect(inv.guestUserId).toBeNull();
    expect(inv.code!.length).toBeGreaterThanOrEqual(16);
    expect(inv.status).toBe('pending');
    const accepted = await acceptCabalInvite(ctx, guest, inv.inviteId);
    expect(accepted.guestUserId).toBe(guest);
    expect(accepted.usedAt).not.toBeNull();
  });

  it('acceptCabalInvite refuses the host accepting their own invite', async () => {
    const ctx = buildContext();
    const host = await newUser('self');
    await setBalance(host, MARINA_GATE_CENTS);
    const inv = await createCabalInvite(ctx, host);
    await expect(acceptCabalInvite(ctx, host, inv.inviteId)).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
  });

  it('acceptCabalInvite refuses a second accept (single-use)', async () => {
    const ctx = buildContext();
    const host = await newUser('h2');
    await setBalance(host, MARINA_GATE_CENTS);
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
    await setBalance(host, MARINA_GATE_CENTS);
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
    await setBalance(host, MARINA_GATE_CENTS);
    const guest = await newUser('g5');
    const inv1 = await createCabalInvite(ctx, host);
    const inv2 = await createCabalInvite(ctx, host);
    await acceptCabalInvite(ctx, guest, inv1.inviteId);
    const used = await listCabalInvites(ctx, host, { hostUserId: host, used: true });
    expect(used.length).toBe(1);
    expect(used[0]!.inviteId).toBe(inv1.inviteId);
    const unused = await listCabalInvites(ctx, host, { hostUserId: host, used: false });
    expect(unused.length).toBe(1);
    expect(unused[0]!.inviteId).toBe(inv2.inviteId);
  });

  it('listCabalInvites rejects bad limit', async () => {
    const ctx = buildContext();
    const testHost = await newUser('h6');
    await expect(listCabalInvites(ctx, testHost, {}, 0)).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
  });
});

describe('Cabal invites (unlock A3)', () => {
  async function richHost(tag: string): Promise<string> {
    const h = await newUser(tag);
    await setBalance(h, MARINA_GATE_CENTS);
    return h;
  }

  it('refuses a host below the net-worth gate and caps pending invites', async () => {
    const ctx = buildContext();
    const poor = await newUser('a3poor');
    await setBalance(poor, MARINA_GATE_CENTS - 1);
    await expect(createCabalInvite(ctx, poor)).rejects.toBeInstanceOf(NetWorthTooLowError);
    const host = await richHost('a3cap');
    const made = [];
    for (let i = 0; i < CABAL_INVITES_PER_HOST; i++) made.push(await createCabalInvite(ctx, host));
    await expect(createCabalInvite(ctx, host)).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'invites_exhausted' },
    });
    // A revoked invite frees a slot.
    await revokeCabalInvite(ctx, host, made[0]!.inviteId);
    expect((await getMyCabal(ctx, host)).invitesRemaining).toBe(1);
    await expect(createCabalInvite(ctx, host)).resolves.toMatchObject({ status: 'pending' });
  });

  it('a targeted invite is only for its guest', async () => {
    const ctx = buildContext();
    const host = await richHost('a3t');
    const guest = await newUser('a3tg');
    const stranger = await newUser('a3ts');
    const rung: UserMessage[] = [];
    const sub = subscribeUserMessages(ctx.redis.main, (m) => {
      if (m.type === 'cabal_invite') rung.push(m);
    });
    await new Promise((r) => setTimeout(r, 150));
    const inv = await createCabalInvite(ctx, host, guest);
    expect(inv.guestUserId).toBe(guest);
    await new Promise((r) => setTimeout(r, 150));
    await sub.quit();
    expect(rung.filter((m) => m.userId === guest).map((m) => m.payload)).toEqual([
      expect.objectContaining({
        inviteId: inv.inviteId,
        fromUserId: host,
        expiresAt: Date.parse(inv.expiresAt),
      }),
    ]);
    expect(JSON.stringify(rung)).not.toContain(inv.code!);
    await expect(acceptCabalInvite(ctx, stranger, inv.inviteId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      details: { reason: 'not_guest' },
    });
    // The guest sees it in their list, without the bearer code.
    const mine = await listCabalInvites(ctx, guest, { guestUserId: guest });
    expect(mine.map((i) => i.inviteId)).toEqual([inv.inviteId]);
    expect(mine[0]!.code).toBeUndefined();
    expect(mine[0]!.status).toBe('pending');
    const ok = await acceptCabalInvite(ctx, guest, inv.inviteId);
    expect(ok.status).toBe('accepted');
    // Now a member: a second invite to them is a conflict.
    await expect(createCabalInvite(ctx, host, guest)).rejects.toMatchObject({
      details: { reason: 'already_member' },
    });
  });

  it('refuses self, unknown, blocked and duplicate targets', async () => {
    const ctx = buildContext();
    const host = await richHost('a3r');
    const guest = await newUser('a3rg');
    const blocked = await newUser('a3rb');
    await expect(createCabalInvite(ctx, host, host)).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(createCabalInvite(ctx, host, uuidv7())).rejects.toBeInstanceOf(NotFoundError);
    await pool.query(`INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2)`, [
      blocked,
      host,
    ]);
    await expect(createCabalInvite(ctx, host, blocked)).rejects.toBeInstanceOf(BlockedError);
    await createCabalInvite(ctx, host, guest);
    await expect(createCabalInvite(ctx, host, guest)).rejects.toMatchObject({
      details: { reason: 'invite_pending' },
    });
  });

  it('refuses an open invite to a player in a block pair with the host', async () => {
    const ctx = buildContext();
    const host = await richHost('a3ob');
    const guest = await newUser('a3obg');
    const inv = await createCabalInvite(ctx, host);
    await pool.query(`INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2)`, [
      host,
      guest,
    ]);
    await expect(acceptCabalInvite(ctx, guest, inv.inviteId)).rejects.toBeInstanceOf(BlockedError);
  });

  it('revoke: host only, pending only, and a revoked invite cannot be accepted', async () => {
    const ctx = buildContext();
    const host = await richHost('a3v');
    const guest = await newUser('a3vg');
    const inv = await createCabalInvite(ctx, host, guest);
    await expect(revokeCabalInvite(ctx, guest, inv.inviteId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      details: { reason: 'not_host' },
    });
    const r = await revokeCabalInvite(ctx, host, inv.inviteId);
    expect(r.status).toBe('revoked');
    expect(r.revokedAt).not.toBeNull();
    await expect(revokeCabalInvite(ctx, host, inv.inviteId)).rejects.toBeInstanceOf(ConflictError);
    await expect(acceptCabalInvite(ctx, guest, inv.inviteId)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(revokeCabalInvite(ctx, host, uuidv7())).rejects.toBeInstanceOf(NotFoundError);
    // Accepted and expired invites are not pending either.
    const used = await createCabalInvite(ctx, host);
    await acceptCabalInvite(ctx, guest, used.inviteId);
    await expect(revokeCabalInvite(ctx, host, used.inviteId)).rejects.toMatchObject({
      details: { reason: 'not_pending', status: 'accepted' },
    });
    const old = await createCabalInvite(ctx, host);
    await pool.query(
      `UPDATE cabal_invites SET expires_at = now() - interval '1 day' WHERE invite_id = $1`,
      [old.inviteId],
    );
    await expect(revokeCabalInvite(ctx, host, old.inviteId)).rejects.toMatchObject({
      details: { reason: 'not_pending', status: 'expired' },
    });
  });
});

describe('Cabal invite rate limits (review L11)', () => {
  it('revoke-and-resend to the same guest is cooled down; one guest gets at most 10 an hour', async () => {
    const ctx = buildContext();
    const host = await newUser('l11h');
    await setBalance(host, MARINA_GATE_CENTS);
    const guest = await newUser('l11g');
    const first = await createCabalInvite(ctx, host, guest);
    await revokeCabalInvite(ctx, host, first.inviteId);
    await expect(createCabalInvite(ctx, host, guest)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      details: { reason: 'invite_cooldown' },
    });
    // After the cooldown the same host may invite again.
    const later = new Date(Date.now() + 11 * 60_000);
    await expect(createCabalInvite(ctx, host, guest, later)).resolves.toMatchObject({
      status: 'pending',
    });
    // Ten other hosts fill the guest's hour; the eleventh is refused.
    const target = await newUser('l11t');
    for (let i = 0; i < 10; i++) {
      const h = await newUser(`l11x${i}`);
      await setBalance(h, MARINA_GATE_CENTS);
      await createCabalInvite(ctx, h, target);
    }
    const h11 = await newUser('l11y');
    await setBalance(h11, MARINA_GATE_CENTS);
    await expect(createCabalInvite(ctx, h11, target)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      details: { reason: 'target_invite_cap' },
    });
  });
});
