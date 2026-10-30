/**
 * Moderation: text filter on DMs / posts / aliases, report rate limit and
 * dedupe, the admin queue (list, dismiss, remove content, mute, ban), mute and
 * ban enforcement, and who can hear a room `say`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { Keypair } from '@solana/web3.js';
import { buildServer } from './main.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { createDb } from '../shared/db/pool.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { authenticateJoin, loadSayPolicy } from '../realtime/player.js';
import { createRedis } from '../shared/redis/client.js';
import { BAN_CHANNEL, bannedFlagKey } from '../application/moderation.js';
import { buildContext } from '../application/context.js';
import { chatWithLlmNpc, stubLlmClient } from '../application/llm-npcs.js';

loadDotenv({ path: process.cwd() + '/.env' });

const adminKey = Keypair.generate();
let app: Awaited<ReturnType<typeof buildServer>>['app'];
let stop: () => Promise<void>;
const db = createDb();

beforeAll(async () => {
  process.env.APP_ENV = process.env.APP_ENV ?? 'local';
  process.env.NODE_ENV = process.env.NODE_ENV ?? 'development';
  process.env.LOG_LEVEL = 'warn';
  process.env.ENABLE_DEV_AUTH = 'true';
  process.env.ADMIN_WALLETS = adminKey.publicKey.toBase58();
  _resetConfigForTests();
  const handle = await buildServer();
  app = handle.app;
  await app.ready();
  stop = handle.stop;
}, 30_000);
afterAll(async () => {
  await stop();
}, 30_000);

interface U {
  sub: string;
  token: string;
  refresh: string;
  wallet: string;
}
async function devAuth(kp = Keypair.generate()): Promise<U> {
  const wallet = kp.publicKey.toBase58();
  const r = await app.inject({
    method: 'POST',
    url: '/v1/auth/dev',
    headers: { 'idempotency-key': `mod-${uuidv7()}` },
    payload: { wallet },
  });
  expect(r.statusCode, r.body).toBe(200);
  const b = r.json() as { id: string; accessToken: string; refreshToken: string };
  return { sub: b.id, token: b.accessToken, refresh: b.refreshToken, wallet };
}
async function call(u: U, method: 'GET' | 'POST', url: string, payload?: unknown) {
  const r = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${u.token}`,
      ...(method === 'GET' ? {} : { 'idempotency-key': uuidv7() }),
    },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
  const body = r.body ? (r.json() as Record<string, any>) : {};
  return { status: r.statusCode, body, code: body.error?.code as string | undefined };
}
const q = <T extends Record<string, unknown>>(sql: string, p: unknown[]) =>
  db.withConnection(async (c) => (await c.query<T>(sql, p)).rows);

describe('text filter', () => {
  it('refuses profanity in DMs and posts with CONTENT_NOT_ALLOWED, accepts clean text', async () => {
    const a = await devAuth();
    const b = await devAuth();
    const bad = await call(a, 'POST', `/v1/dms/${b.sub}`, { text: 'you piece of sh1t' });
    expect(bad.status).toBe(400);
    expect(bad.code).toBe('CONTENT_NOT_ALLOWED');
    expect(bad.body.error.details.field).toBe('dm');
    expect(
      (await call(a, 'POST', `/v1/dms/${b.sub}`, { text: 'gm, this hit the spot' })).status,
    ).toBe(201);
    const post = await call(a, 'POST', '/v1/feed/posts', { text: 'fuck this' });
    expect(post.code).toBe('CONTENT_NOT_ALLOWED');
    expect((await call(a, 'POST', '/v1/feed/posts', { text: 'gm ct' })).status).toBe(201);
  });

  it('refuses a profane alias before touching anything else', async () => {
    const a = await devAuth();
    const r = await call(a, 'POST', '/v1/characters', {
      alias: 'f_u_c_k_er',
      look: {
        skinTone: 's',
        headId: 'h',
        hairId: 'h',
        topId: 't',
        bottomId: 'b',
        shoesId: 's',
        accId: 'a',
      },
      traitIds: ['x', 'y'],
      dreamId: 'd',
      tribeId: 't',
      ageConfirmed: true,
    });
    expect(r.code).toBe('CONTENT_NOT_ALLOWED');
    expect(r.body.error.details.field).toBe('alias');
  });
});

describe('reports', () => {
  it('rate limits reporters (5 burst) and dedupes an open report on the same target', async () => {
    const a = await devAuth();
    const victim = await devAuth();
    const file = (targetId: string) =>
      call(a, 'POST', '/v1/reports', { targetType: 'user', targetId, reasonId: 'spam' });
    expect((await file(victim.sub)).status).toBe(204);
    expect((await file(victim.sub)).status).toBe(204); // dup: no-op
    expect(
      await q('SELECT 1 FROM reports WHERE reporter_user_id = $1 AND target_id = $2', [
        a.sub,
        victim.sub,
      ]),
    ).toHaveLength(1);
    // The dup spent a token too (the limit counts attempts). Burn the rest.
    const codes: Array<number> = [];
    for (let i = 0; i < 6; i++) codes.push((await file(uuidv7())).status);
    expect(codes).toContain(429);
    const limited = await file(uuidv7());
    expect(limited.status).toBe(429);
    expect(limited.code).toBe('RATE_LIMITED');
    // Reporting yourself is refused.
    const c = await devAuth();
    const self = await call(c, 'POST', '/v1/reports', {
      targetType: 'user',
      targetId: c.sub,
      reasonId: 'x',
    });
    expect(self.status).toBe(400);
  });
});

describe('admin queue', () => {
  it('is admin only', async () => {
    const p = await devAuth();
    expect((await call(p, 'GET', '/v1/admin/reports')).status).toBe(403);
    expect(
      (await call(p, 'POST', '/v1/admin/reports/1/resolve', { action: 'dismiss' })).status,
    ).toBe(403);
    expect(
      (await call(p, 'POST', `/v1/admin/users/${p.sub}/sanction`, { action: 'ban' })).status,
    ).toBe(403);
  });

  it('takes a report on an AI NPC reply from the player it was written for', async () => {
    const admin = await devAuth(adminKey);
    const player = await devAuth();
    const other = await devAuth();
    const reply = await chatWithLlmNpc(
      buildContext(),
      { userId: player.sub, archetype: 'ai_agent', message: 'gm' },
      stubLlmClient('buy my bags, ser'),
    );
    expect(reply.replyId).toMatch(/^[0-9a-f-]{36}$/);
    expect(reply.archetype).toBe('ai_agent');

    const ok = await call(player, 'POST', '/v1/reports', {
      targetType: 'npc_reply',
      targetId: reply.replyId,
      reasonId: 'scam',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(204);
    // Someone else's reply, or an id that is no reply at all, is refused.
    for (const [u, targetId] of [
      [other, reply.replyId],
      [player, uuidv7()],
      [player, 'not-a-uuid'],
    ] as const) {
      const bad = await call(u, 'POST', '/v1/reports', {
        targetType: 'npc_reply',
        targetId,
        reasonId: 'scam',
      });
      expect(bad.status).toBe(400);
      expect(bad.body.error.details.reason).toBe('unknown_reply');
    }

    const list = await call(admin, 'GET', '/v1/admin/reports?status=open&limit=100');
    const row = (list.body.reports as Array<Record<string, any>>).find(
      (r) => r.targetId === reply.replyId,
    )!;
    expect(row.targetType).toBe('npc_reply');
    expect(row.preview).toBe('buy my bags, ser');
    expect(row.targetUserId).toBeNull();
    const rm = await call(admin, 'POST', `/v1/admin/reports/${row.reportId}/resolve`, {
      action: 'remove_content',
    });
    expect(rm.status).toBe(200);
    expect(
      (
        await q<{ response_text: string }>(
          'SELECT response_text FROM llm_npc_interactions WHERE interaction_id = $1',
          [reply.replyId],
        )
      )[0]!.response_text,
    ).toBe('[removed]');
  });

  it('lists with a preview, removes content, closes duplicates, mutes and bans', async () => {
    const admin = await devAuth(adminKey);
    const bully = await devAuth();
    const r1 = await devAuth();
    const r2 = await devAuth();
    // The bully sends a DM (clean at the time) and posts; both get reported.
    const dm = await call(bully, 'POST', `/v1/dms/${r1.sub}`, { text: 'meet me behind the bank' });
    const messageId = dm.body.messageId as string;
    const post = await call(bully, 'POST', '/v1/feed/posts', { text: 'free money click here' });
    const postId = post.body.postId as string;
    await call(r1, 'POST', '/v1/reports', {
      targetType: 'message',
      targetId: messageId,
      reasonId: 'threat',
    });
    await call(r2, 'POST', '/v1/reports', {
      targetType: 'message',
      targetId: messageId,
      reasonId: 'threat',
    });
    await call(r1, 'POST', '/v1/reports', {
      targetType: 'post',
      targetId: postId,
      reasonId: 'scam',
    });

    const list = await call(admin, 'GET', '/v1/admin/reports?status=open&limit=100');
    expect(list.status).toBe(200);
    const mine = (list.body.reports as Array<Record<string, any>>).filter(
      (r) => r.targetId === messageId || r.targetId === postId,
    );
    expect(mine).toHaveLength(3);
    const msgReport = mine.find((r) => r.targetId === messageId)!;
    expect(msgReport.preview).toBe('meet me behind the bank');
    expect(msgReport.targetUserId).toBe(bully.sub);
    expect(msgReport.openOnTarget).toBe(2);

    // remove_content closes both reports on that message and blanks the text.
    const rm = await call(admin, 'POST', `/v1/admin/reports/${msgReport.reportId}/resolve`, {
      action: 'remove_content',
    });
    expect(rm.status).toBe(200);
    expect(rm.body.closed).toBe(2);
    expect(
      (
        await q<{ text: string }>('SELECT text FROM dm_messages WHERE message_id = $1', [messageId])
      )[0]!.text,
    ).toBe('[removed]');
    expect(
      (
        await call(admin, 'POST', `/v1/admin/reports/${msgReport.reportId}/resolve`, {
          action: 'dismiss',
        })
      ).status,
    ).toBe(409);

    // mute from the post report: the bully can no longer DM or post, with the mute end in the error.
    const postReport = mine.find((r) => r.targetId === postId)!;
    const mute = await call(admin, 'POST', `/v1/admin/reports/${postReport.reportId}/resolve`, {
      action: 'mute',
      hours: 2,
      note: 'scam links',
    });
    expect(mute.status).toBe(200);
    const muted = await call(bully, 'POST', '/v1/feed/posts', { text: 'still here' });
    expect(muted.status).toBe(403);
    expect(muted.code).toBe('ACCOUNT_MUTED');
    expect(muted.body.error.details.until).toBeTruthy();
    expect((await call(bully, 'POST', `/v1/dms/${r1.sub}`, { text: 'hello' })).code).toBe(
      'ACCOUNT_MUTED',
    );
    expect((await loadSayPolicy(bully.sub)).muted).toBe(true);
    // Reading still works while muted.
    expect((await call(bully, 'GET', '/v1/feed')).status).toBe(200);

    // unmute, then ban: live token dies at once and login/refresh refuse.
    expect(
      (await call(admin, 'POST', `/v1/admin/users/${bully.sub}/sanction`, { action: 'unmute' }))
        .status,
    ).toBe(204);
    expect((await call(bully, 'POST', '/v1/feed/posts', { text: 'back' })).status).toBe(201);
    expect(
      (await call(admin, 'POST', `/v1/admin/users/${bully.sub}/sanction`, { action: 'ban' }))
        .status,
    ).toBe(204);
    const banned = await call(bully, 'GET', '/v1/feed');
    expect(banned.status).toBe(403);
    expect(banned.code).toBe('ACCOUNT_BANNED');
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev',
      headers: { 'idempotency-key': uuidv7() },
      payload: { wallet: bully.wallet },
    });
    expect(login.statusCode).toBe(403);
    // Unban restores access.
    expect(
      (await call(admin, 'POST', `/v1/admin/users/${bully.sub}/sanction`, { action: 'unban' }))
        .status,
    ).toBe(204);
    expect((await call(bully, 'GET', '/v1/feed')).status).toBe(200);

    const log = await q<{ action: string }>(
      'SELECT action FROM moderation_actions WHERE target_user_id = $1 ORDER BY id',
      [bully.sub],
    );
    expect(log.map((l) => l.action)).toEqual(['remove_content', 'mute', 'unmute', 'ban', 'unban']);
  });

  it('dismiss closes the report; remove_content on a user report is refused', async () => {
    const admin = await devAuth(adminKey);
    const a = await devAuth();
    const t = await devAuth();
    await call(a, 'POST', '/v1/reports', { targetType: 'user', targetId: t.sub, reasonId: 'x' });
    const rep = (
      await q<{ report_id: string }>(
        'SELECT report_id FROM reports WHERE reporter_user_id = $1 AND resolved_at IS NULL',
        [a.sub],
      )
    )[0]!;
    expect(
      (
        await call(admin, 'POST', `/v1/admin/reports/${rep.report_id}/resolve`, {
          action: 'remove_content',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(admin, 'POST', `/v1/admin/reports/${rep.report_id}/resolve`, {
          action: 'dismiss',
        })
      ).status,
    ).toBe(200);
    expect(
      (await call(admin, 'POST', `/v1/admin/reports/999999999/resolve`, { action: 'dismiss' }))
        .status,
    ).toBe(404);
  });
});

describe('room say audience', () => {
  it('lists blocks in both directions and the mute', async () => {
    const a = await devAuth();
    const b = await devAuth();
    const c = await devAuth();
    const d = await devAuth();
    expect(await loadSayPolicy(a.sub)).toEqual({ muted: false, blocked: new Set() });
    // a blocks b (service inserts both rows); d blocks a the other way.
    await call(a, 'POST', `/v1/blocks/${b.sub}`);
    await call(d, 'POST', `/v1/blocks/${a.sub}`);
    const p = await loadSayPolicy(a.sub);
    expect([...p.blocked].sort()).toEqual([b.sub, d.sub].sort());
    expect(p.blocked.has(c.sub)).toBe(false);
    // b hears nothing from a, and a nothing from b.
    expect((await loadSayPolicy(b.sub)).blocked.has(a.sub)).toBe(true);
  });
});

describe('ban reaches realtime and sessions', () => {
  it('refuses a banned player at the door (flag, and the database when the flag is gone), kicks live sessions, drops their say, blocks refresh', async () => {
    const admin = await devAuth(adminKey);
    const u = await devAuth();
    expect(await authenticateJoin({ token: u.token })).toBe(u.sub);

    // Listen for the kick the way a room does.
    const sub = createRedis().main.duplicate();
    const kicked: string[] = [];
    await sub.subscribe(BAN_CHANNEL);
    sub.on('message', (_ch, msg) => kicked.push((JSON.parse(msg) as { userId: string }).userId));

    expect(
      (await call(admin, 'POST', `/v1/admin/users/${u.sub}/sanction`, { action: 'ban' })).status,
    ).toBe(204);
    await new Promise((r) => setTimeout(r, 200));
    expect(kicked).toContain(u.sub);

    // Join: refused with the still-valid access token.
    await expect(authenticateJoin({ token: u.token })).rejects.toThrow('ACCOUNT_BANNED');
    // Redis flag lost (flush or expiry): the database still refuses.
    await buildContext().redis.main.del(bannedFlagKey(u.sub));
    await expect(authenticateJoin({ token: u.token })).rejects.toThrow('ACCOUNT_BANNED');

    // Say: a banned player counts as silenced.
    expect((await loadSayPolicy(u.sub)).muted).toBe(true);

    // Refresh cannot mint a new access token.
    const refresh = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { 'idempotency-key': uuidv7() },
      payload: { refreshToken: u.refresh },
    });
    expect(refresh.statusCode).toBe(403);
    expect((refresh.json() as { error: { code: string } }).error.code).toBe('ACCOUNT_BANNED');

    // Unban: the door opens again.
    await call(admin, 'POST', `/v1/admin/users/${u.sub}/sanction`, { action: 'unban' });
    expect(await authenticateJoin({ token: u.token })).toBe(u.sub);
    await sub.quit();
  });
});
