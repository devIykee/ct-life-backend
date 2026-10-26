/**
 * Group chats and alpha groups (migration 103): caps, invite-only joins,
 * server-graded calls, PnL wins, safety (masking, blocks, removal bans, slow
 * mode, report-to-hide) and booths.
 */
import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { config as loadDotenv } from 'dotenv';

vi.mock('./realtime-bus.js', async (orig) => ({
  ...(await orig<typeof import('./realtime-bus.js')>()),
  publishToUser: vi.fn(async () => undefined),
}));

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import {
  BlockedError,
  ConflictError,
  ForbiddenError,
  NameNotAllowedError,
  NotFoundError,
  RateLimitedError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import { publishToUser } from './realtime-bus.js';
import { encodePos, getIslandGeometry, POS_HASH } from '../realtime/movement.js';
import {
  acceptInvite,
  claimBooth,
  cleanChatText,
  createGroup,
  createInviteLink,
  declineInvite,
  getGroup,
  GROUP_CAPS,
  inviteUser,
  leaveGroup,
  listBooths,
  listMembers,
  listMessages,
  listMyGroups,
  listMyInvites,
  postMessage,
  previewInvite,
  removeMember,
  reportGroup,
  updateGroup,
} from './groups.js';

loadDotenv({ path: process.cwd() + '/.env' });
_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ctx = buildContext();

afterAll(async () => {
  await pool.end();
});
beforeEach(() => vi.mocked(publishToUser).mockClear());

async function player(tribe = 'trencher'): Promise<string> {
  const id = uuidv7();
  await pool.query(`INSERT INTO users (id, wallet, lottery_rolled_at) VALUES ($1, $2, now())`, [
    id,
    `gc-${id}`,
  ]);
  await pool.query(
    `INSERT INTO characters (id, user_id, alias, look, tribe_id, trait_ids, dream_id, age_confirmed_at, home_id)
     VALUES ($1, $2, $3, '{}', $4, '{a,b}', 'make_10k', now(), 'studio')`,
    [uuidv7(), id, `gc_${id.slice(-12)}`, tribe],
  );
  return id;
}

async function join(groupId: string, owner: string, ...users: string[]): Promise<void> {
  const link = await createInviteLink(ctx, owner, groupId, { maxUses: 100 });
  for (const u of users) await acceptInvite(ctx, u, link.code);
}

async function coin(price = 2_000_000): Promise<string> {
  const id = uuidv7();
  await pool.query(
    `INSERT INTO coins (coin_id, ticker, name, stage, price_micros, mcap_cents, launched_at, hidden_arc, seed)
     VALUES ($1, $2, 'Group Coin', 'new', $3, 100, '2000-01-01', '{}', 1)`,
    [id, `G${Math.random().toString(36).slice(2, 8).toUpperCase()}`, price],
  );
  return id;
}

describe('creating and joining (free, invite-only)', () => {
  it('creates a friends group with the creator as owner and a 12 cap', async () => {
    const owner = await player();
    const g = await createGroup(ctx, owner, { kind: 'friends', name: 'the boys' });
    expect(g).toMatchObject({ kind: 'friends', role: 'owner', memberCount: 1, memberCap: 12 });
    expect(GROUP_CAPS).toEqual({ friends: 12, alpha: 50, tribe: 200 });
    await expect(
      createGroup(ctx, owner, { kind: 'friends', name: 'f u c k' }),
    ).rejects.toBeInstanceOf(NameNotAllowedError);
  });

  it('a stranger cannot see a group; a link lets them in; the cap holds', async () => {
    const owner = await player();
    const g = await createGroup(ctx, owner, { kind: 'friends', name: 'cap test' });
    const stranger = await player();
    await expect(getGroup(ctx, stranger, g.groupId)).rejects.toBeInstanceOf(NotFoundError);
    const link = await createInviteLink(ctx, owner, g.groupId, { maxUses: 50 });
    expect(link.deepLink).toBe(`ctlife://invite/${link.code}`);
    const preview = await previewInvite(ctx, stranger, link.code);
    expect(preview).toMatchObject({ groupName: 'cap test', valid: true, memberCount: 1 });
    // Fill to 12 at once: exactly 11 more fit, whatever the timing.
    const others = await Promise.all(Array.from({ length: 13 }, () => player()));
    const results = await Promise.allSettled(others.map((u) => acceptInvite(ctx, u, link.code)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(11);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(ConflictError);
    }
    expect((await getGroup(ctx, owner, g.groupId)).memberCount).toBe(12);
  });

  it('a link with max uses is used up', async () => {
    const owner = await player();
    const g = await createGroup(ctx, owner, { kind: 'friends', name: 'one use' });
    const link = await createInviteLink(ctx, owner, g.groupId, { maxUses: 1 });
    await acceptInvite(ctx, await player(), link.code);
    await expect(acceptInvite(ctx, await player(), link.code)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('direct invites wait in the Invites list; blocked pairs cannot invite; decline works', async () => {
    const owner = await player();
    const friend = await player();
    const enemy = await player();
    await pool.query(`INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2)`, [
      enemy,
      owner,
    ]);
    const g = await createGroup(ctx, owner, {
      kind: 'friends',
      name: 'invites',
      inviteUserIds: [friend, enemy],
    });
    expect(vi.mocked(publishToUser)).toHaveBeenCalledWith(
      expect.anything(),
      friend,
      'group_invite',
      expect.objectContaining({ groupId: g.groupId, groupName: 'invites' }),
    );
    const mine = await listMyInvites(ctx, friend);
    expect(mine.map((i) => i.groupId)).toEqual([g.groupId]);
    expect(await listMyInvites(ctx, enemy)).toEqual([]);
    await expect(inviteUser(ctx, owner, g.groupId, enemy)).rejects.toBeInstanceOf(BlockedError);
    // someone else cannot use a direct invite
    await expect(acceptInvite(ctx, enemy, mine[0]!.code)).rejects.toBeInstanceOf(NotFoundError);
    await declineInvite(ctx, friend, mine[0]!.code);
    expect(await listMyInvites(ctx, friend)).toEqual([]);
  });

  it('joins your tribe chat automatically', async () => {
    const u = await player('builder');
    const groups = await listMyGroups(ctx, u);
    const tribe = groups.find((x) => x.kind === 'tribe')!;
    expect(tribe).toMatchObject({ name: 'Builder tribe', memberCap: 200, role: 'member' });
    await expect(leaveGroup(ctx, u, tribe.groupId)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('messages and safety', () => {
  it('masks links, e-mails, phones and wallets', () => {
    expect(cleanChatText('dm me at scam.xyz/claim or a@b.co, 555-123-4567')).toBe(
      'dm me at [link] or [hidden], [phone]',
    );
    expect(cleanChatText('send to 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU')).toBe(
      'send to [wallet]',
    );
  });

  it('delivers to members over the bus, never to someone who blocked the author', async () => {
    const owner = await player();
    const a = await player();
    const b = await player();
    const g = await createGroup(ctx, owner, { kind: 'friends', name: 'chat' });
    await join(g.groupId, owner, a, b);
    await pool.query(`INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2)`, [
      b,
      owner,
    ]);
    vi.mocked(publishToUser).mockClear();
    const m = await postMessage(ctx, owner, g.groupId, { topic: 'chat', text: 'gm www.x.com' });
    expect(m.text).toBe('gm [link]');
    const to = vi.mocked(publishToUser).mock.calls.map((c) => c[1]);
    expect(to).toEqual([a]);
    expect(vi.mocked(publishToUser).mock.calls[0]![2]).toBe('group_msg');
    // b does not see the blocked author in history either
    expect((await listMessages(ctx, b, g.groupId, 'chat', null)).messages).toEqual([]);
    expect((await listMessages(ctx, a, g.groupId, 'chat', null)).messages).toHaveLength(1);
    // unread for a
    expect((await listMyGroups(ctx, a)).find((x) => x.groupId === g.groupId)!.unread).toBe(1);
  });

  it('slow mode limits members, not the owner', async () => {
    const owner = await player();
    const a = await player();
    const g = await createGroup(ctx, owner, { kind: 'friends', name: 'slow' });
    await join(g.groupId, owner, a);
    await updateGroup(ctx, owner, g.groupId, { slowMode: { chat: 30 } });
    await postMessage(ctx, a, g.groupId, { topic: 'chat', text: 'one' });
    await expect(
      postMessage(ctx, a, g.groupId, { topic: 'chat', text: 'two' }),
    ).rejects.toBeInstanceOf(RateLimitedError);
    await postMessage(ctx, owner, g.groupId, { topic: 'chat', text: 'a' });
    await postMessage(ctx, owner, g.groupId, { topic: 'chat', text: 'b' });
  });

  it('removed players are banned from rejoining; mods cannot remove the owner', async () => {
    const owner = await player();
    const mod = await player();
    const troll = await player();
    const g = await createGroup(ctx, owner, { kind: 'alpha', name: 'removal' });
    const link = await createInviteLink(ctx, owner, g.groupId, { maxUses: 10 });
    await acceptInvite(ctx, mod, link.code);
    await acceptInvite(ctx, troll, link.code);
    await pool.query(`UPDATE group_members SET role = 'mod' WHERE group_id = $1 AND user_id = $2`, [
      g.groupId,
      mod,
    ]);
    await expect(removeMember(ctx, mod, g.groupId, owner)).rejects.toBeInstanceOf(ForbiddenError);
    await removeMember(ctx, mod, g.groupId, troll);
    await expect(acceptInvite(ctx, troll, link.code)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('the owner leaving hands the group to a mod, then the oldest member', async () => {
    const owner = await player();
    const a = await player();
    const g = await createGroup(ctx, owner, { kind: 'friends', name: 'handover' });
    await join(g.groupId, owner, a);
    await leaveGroup(ctx, owner, g.groupId);
    const members = await listMembers(ctx, a, g.groupId);
    expect(members).toEqual([expect.objectContaining({ userId: a, role: 'owner' })]);
    await leaveGroup(ctx, a, g.groupId);
    const gone = await pool.query(`SELECT 1 FROM groups WHERE group_id = $1`, [g.groupId]);
    expect(gone.rowCount).toBe(0);
  });

  it('three different reporters hide a group', async () => {
    const owner = await player();
    const rs = await Promise.all([player(), player(), player()]);
    const g = await createGroup(ctx, owner, { kind: 'alpha', name: 'scam calls' });
    await join(g.groupId, owner, ...rs);
    expect(await reportGroup(ctx, rs[0]!, g.groupId, 'scam', null)).toEqual({ hidden: false });
    expect(await reportGroup(ctx, rs[0]!, g.groupId, 'scam', null)).toEqual({ hidden: false });
    expect(await reportGroup(ctx, rs[1]!, g.groupId, 'spam', null)).toEqual({ hidden: false });
    expect(await reportGroup(ctx, rs[2]!, g.groupId, 'scam', 'wallet drainer')).toEqual({
      hidden: true,
    });
    await expect(getGroup(ctx, owner, g.groupId)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listMyGroups(ctx, owner)).find((x) => x.groupId === g.groupId)).toBeUndefined();
  });
});

describe('alpha groups', () => {
  it('only the caller posts calls; the entry is the server price and the card shows the grade', async () => {
    const caller = await player();
    const member = await player();
    const g = await createGroup(ctx, caller, { kind: 'alpha', name: 'Frog Calls' });
    await join(g.groupId, caller, member);
    const coinId = await coin(2_000_000);
    await expect(
      postMessage(ctx, member, g.groupId, { topic: 'calls', coinId, targetX: 3, stopPct: 40 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const m = await postMessage(ctx, caller, g.groupId, {
      topic: 'calls',
      coinId,
      targetX: 3,
      stopPct: 40,
      text: 'NEW CALL',
    });
    expect(m.card).toMatchObject({
      type: 'call',
      coinId,
      entryMicros: '2000000',
      targetMicros: '6000000',
      stopMicros: '1200000',
      status: 'open',
      priceMicros: '2000000',
    });
    const row = await pool.query(`SELECT status, user_id FROM alpha_calls WHERE call_id = $1`, [
      (m.card as { callId: string }).callId,
    ]);
    expect(row.rows[0]).toEqual({ status: 'open', user_id: caller });
    // The grade is read live: the evaluator marks it hit, the card follows.
    await pool.query(`UPDATE alpha_calls SET status = 'hit_target' WHERE call_id = $1`, [
      (m.card as { callId: string }).callId,
    ]);
    const calls = await listMessages(ctx, member, g.groupId, 'calls', null);
    expect(calls.messages[0]!.card).toMatchObject({ status: 'hit_target' });
    const info = await getGroup(ctx, member, g.groupId);
    expect(info.topics).toEqual(['calls', 'chat', 'wins']);
    expect(info.trust).not.toBeNull();
    // friends groups have chat only
    const f = await createGroup(ctx, caller, { kind: 'friends', name: 'no calls' });
    await expect(
      postMessage(ctx, caller, f.groupId, { topic: 'calls', coinId, targetX: 2, stopPct: 10 }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('a win needs real realized profit on the coin', async () => {
    const caller = await player();
    const member = await player();
    const g = await createGroup(ctx, caller, { kind: 'alpha', name: 'Wins' });
    await join(g.groupId, caller, member);
    const coinId = await coin();
    await expect(
      postMessage(ctx, member, g.groupId, { topic: 'wins', coinId }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    await pool.query(
      `INSERT INTO positions (position_id, user_id, coin_id, units, cost_basis_cents, realized_cents)
       VALUES ($1, $2, $3, 0, 0, 8400)`,
      [uuidv7(), member, coinId],
    );
    const m = await postMessage(ctx, member, g.groupId, { topic: 'wins', coinId, text: 'ez' });
    expect(m.card).toMatchObject({ type: 'pnl', coinId, realizedCents: '8400' });
  });

  it('booths: one group per booth, one booth per group, with who is here', async () => {
    const a = await player();
    const b = await player();
    const ga = await createGroup(ctx, a, { kind: 'alpha', name: 'Booth A' });
    const gb = await createGroup(ctx, b, { kind: 'alpha', name: 'Booth B' });
    const fr = await createGroup(ctx, a, { kind: 'friends', name: 'no booth' });
    await pool.query(`DELETE FROM venue_booths WHERE venue_id = 'cabal_lounge'`);
    await claimBooth(ctx, a, ga.groupId, 'cabal_lounge', 'booth_1');
    await expect(claimBooth(ctx, b, gb.groupId, 'cabal_lounge', 'booth_1')).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(claimBooth(ctx, a, fr.groupId, 'cabal_lounge', 'booth_2')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await claimBooth(ctx, a, ga.groupId, 'cabal_lounge', 'booth_2'); // moves
    const door = getIslandGeometry().venues!.cabal_lounge!.door;
    await ctx.redis.main.hset(POS_HASH, a, encodePos({ x: door[0], z: door[1], at: Date.now() }));
    const booths = await listBooths(ctx, 'cabal_lounge');
    expect(booths.find((x) => x.boothId === 'booth_1')!.group).toBeNull();
    expect(booths.find((x) => x.boothId === 'booth_2')!.group).toMatchObject({
      groupId: ga.groupId,
      name: 'Booth A',
      memberCount: 1,
      here: 1,
    });
  });
});
