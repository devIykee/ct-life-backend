/**
 * Builder routes over HTTP: the `builder` capability gate (503 CAPABILITY_OFF),
 * the contract shapes the client parses, every error the client maps, and
 * POST /projects/{id}/hire -> 410 GONE.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { Keypair } from '@solana/web3.js';
import { buildServer } from './main.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { createDb } from '../shared/db/pool.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { _resetContextForTests } from '../application/context.js';

loadDotenv({ path: process.cwd() + '/.env' });

type App = Awaited<ReturnType<typeof buildServer>>['app'];
interface User {
  sub: string;
  token: string;
}

const savedCaps = process.env.CAPABILITIES_ON;

async function boot(caps: string | undefined): Promise<{ app: App; stop: () => Promise<void> }> {
  if (caps === undefined) delete process.env.CAPABILITIES_ON;
  else process.env.CAPABILITIES_ON = caps;
  process.env.ENABLE_DEV_AUTH = 'true';
  process.env.LOG_LEVEL = 'warn';
  _resetConfigForTests();
  _resetContextForTests();
  const h = await buildServer();
  await h.app.ready();
  return { app: h.app, stop: h.stop };
}

async function devAuth(app: App): Promise<User> {
  const r = await app.inject({
    method: 'POST',
    url: '/v1/auth/dev',
    headers: { 'idempotency-key': `proj-${uuidv7()}` },
    payload: { wallet: Keypair.generate().publicKey.toBase58() },
  });
  expect(r.statusCode, r.body).toBe(200);
  const b = r.json() as { id: string; accessToken: string };
  return { sub: b.id, token: b.accessToken };
}

async function call(
  app: App,
  u: User,
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${u.token}`,
      ...(method === 'GET' ? {} : { 'idempotency-key': uuidv7() }),
    },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
  return { status: r.statusCode, body: r.body === '' ? {} : (r.json() as Record<string, unknown>) };
}

const err = (b: Record<string, unknown>): { code: string; details: Record<string, unknown> } =>
  b.error as { code: string; details: Record<string, unknown> };

async function giveCash(u: User, cents: number): Promise<void> {
  await createDb().withConnection((c) =>
    c.query(
      `INSERT INTO balances (user_id, cash_cents) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET cash_cents = EXCLUDED.cash_cents`,
      [u.sub, cents],
    ),
  );
}

afterAll(() => {
  if (savedCaps === undefined) delete process.env.CAPABILITIES_ON;
  else process.env.CAPABILITIES_ON = savedCaps;
  _resetConfigForTests();
  _resetContextForTests();
});

describe('builder capability off', () => {
  it('new routes answer 503 CAPABILITY_OFF; /hire is 410 regardless', async () => {
    const { app, stop } = await boot(undefined);
    try {
      const u = await devAuth(app);
      const id = uuidv7();
      for (const [method, url] of [
        ['POST', `/v1/projects/${id}/offers`],
        ['POST', `/v1/project-offers/${id}/accept`],
        ['POST', `/v1/project-offers/${id}/decline`],
        ['POST', `/v1/projects/${id}/fund`],
        ['DELETE', `/v1/projects/${id}/members/${id}`],
        ['GET', `/v1/projects/${id}/launch-quote`],
        ['POST', `/v1/projects/${id}/launch`],
        ['GET', `/v1/projects/${id}/events`],
        ['POST', `/v1/projects/${id}/tasks`],
        ['POST', `/v1/projects/${id}/tasks/${id}/complete`],
      ] as const) {
        const r = await call(app, u, method, url, method === 'GET' ? undefined : {});
        expect(r.status, `${method} ${url}`).toBe(503);
        expect(err(r.body)).toMatchObject({
          code: 'CAPABILITY_OFF',
          details: { capability: 'builder' },
        });
      }
      const h = await call(app, u, 'POST', `/v1/projects/${id}/hire`, {});
      expect(h.status).toBe(410);
      expect(err(h.body)).toMatchObject({ code: 'GONE', details: { reason: 'use_offers' } });
    } finally {
      await stop();
    }
  }, 30_000);
});

describe('builder capability on', () => {
  let app: App;
  let stop: () => Promise<void>;
  let founder: User;
  let dev: User;
  let stranger: User;

  beforeAll(async () => {
    ({ app, stop } = await boot('builder'));
    founder = await devAuth(app);
    dev = await devAuth(app);
    stranger = await devAuth(app);
    await giveCash(founder, 10_000_000);
  }, 30_000);

  afterAll(async () => {
    await stop();
  });

  it('found -> offer -> accept -> fund -> quote -> launch -> events, with the contract shapes', async () => {
    const p = await call(app, founder, 'POST', '/v1/projects', {
      kind: 'memecoin',
      name: 'Froge Labs',
    });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    const projectId = p.body.projectId as string;
    expect(p.body).toMatchObject({
      name: 'Froge Labs',
      kind: 'memecoin',
      status: 'founded',
      ownerUserId: founder.sub,
      memberCount: 1,
      treasuryCents: 50_000,
      coinId: null,
      openRoles: ['dev', 'mod', 'kol', 'auditor'],
    });

    const band = await call(app, founder, 'POST', `/v1/projects/${projectId}/offers`, {
      userId: dev.sub,
      role: 'dev',
      salaryCentsPerWeek: 1,
    });
    expect(band.status).toBe(400);
    expect(err(band.body)).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'salary_out_of_band', min: 15_000, max: 30_000 },
    });

    const notOwner = await call(app, stranger, 'POST', `/v1/projects/${projectId}/offers`, {
      userId: dev.sub,
      role: 'dev',
      salaryCentsPerWeek: 20_000,
    });
    expect(notOwner.status).toBe(403);
    expect(err(notOwner.body)).toMatchObject({
      code: 'FORBIDDEN',
      details: { reason: 'not_owner' },
    });

    const offer = await call(app, founder, 'POST', `/v1/projects/${projectId}/offers`, {
      userId: dev.sub,
      role: 'dev',
      salaryCentsPerWeek: 20_000,
    });
    expect(offer.status).toBe(201);
    expect(Object.keys(offer.body).sort()).toEqual(
      [
        'offerId',
        'projectId',
        'projectName',
        'fromUserId',
        'toUserId',
        'role',
        'salaryCentsPerWeek',
        'status',
        'expiresAt',
        'createdAt',
      ].sort(),
    );
    const dup = await call(app, founder, 'POST', `/v1/projects/${projectId}/offers`, {
      userId: dev.sub,
      role: 'dev',
      salaryCentsPerWeek: 20_000,
    });
    expect(dup.status).toBe(409);
    expect(err(dup.body).details.reason).toBe('offer_pending');

    const inbox = await call(app, dev, 'GET', '/v1/me/project-offers?status=pending&limit=20');
    expect((inbox.body.offers as Array<{ offerId: string }>)[0]?.offerId).toBe(offer.body.offerId);

    const wrong = await call(
      app,
      stranger,
      'POST',
      `/v1/project-offers/${offer.body.offerId as string}/accept`,
    );
    expect(wrong.status).toBe(403);
    const acc = await call(
      app,
      dev,
      'POST',
      `/v1/project-offers/${offer.body.offerId as string}/accept`,
    );
    expect(acc.status).toBe(200);
    expect(acc.body.status).toBe('accepted');
    const again = await call(
      app,
      dev,
      'POST',
      `/v1/project-offers/${offer.body.offerId as string}/decline`,
    );
    expect(again.status).toBe(409);
    expect(err(again.body).details.reason).toBe('not_pending');

    const fundOther = await call(app, dev, 'POST', `/v1/projects/${projectId}/fund`, {
      cashCents: 100,
    });
    expect(fundOther.status).toBe(403);
    const fund = await call(app, founder, 'POST', `/v1/projects/${projectId}/fund`, {
      cashCents: 25_000,
    });
    expect(fund.status).toBe(200);
    expect((fund.body.project as { treasuryCents: number }).treasuryCents).toBe(75_000);
    const broke = await call(app, stranger, 'POST', '/v1/projects', { kind: 'memecoin' });
    expect(broke.status).toBe(400); // the seed check (unchanged route)

    const q0 = await call(app, founder, 'GET', `/v1/projects/${projectId}/launch-quote`);
    expect(q0.status).toBe(200);
    expect(q0.body).toMatchObject({
      projectId,
      launchCostCents: 50_000,
      builderDiscountBps: 0,
      treasuryCents: 75_000,
      canLaunch: false,
      blockers: ['cooldown'],
    });
    expect(typeof q0.body.quotedAt).toBe('string');
    const cool = await call(app, founder, 'POST', `/v1/projects/${projectId}/launch`, {
      ticker: 'FROGE',
      quotedCostCents: 50_000,
    });
    expect(cool.status).toBe(409);
    expect(err(cool.body).details.reason).toBe('cooldown');

    await createDb().withConnection((c) =>
      c.query(`UPDATE projects SET created_at = now() - interval '1 hour' WHERE project_id = $1`, [
        projectId,
      ]),
    );
    const changed = await call(app, founder, 'POST', `/v1/projects/${projectId}/launch`, {
      ticker: 'FROGE',
      quotedCostCents: 1,
    });
    expect(changed.status).toBe(409);
    expect(err(changed.body).details).toMatchObject({
      reason: 'quote_changed',
      launchCostCents: 50_000,
    });
    const bad = await call(app, founder, 'POST', `/v1/projects/${projectId}/launch`, {
      ticker: 'froge!',
      quotedCostCents: 50_000,
    });
    expect(bad.status).toBe(400);
    // A jailed founder cannot launch (403 JAILED), as on /v1/market/launchpad.
    await createDb().withConnection((c) =>
      c.query(
        `INSERT INTO player_jail (user_id, jail_id, jailed_at, jailed_until, bail_cents, heat_at_arrest)
         VALUES ($1, $2, now(), now() + interval '1 hour', 1000, 5)`,
        [founder.sub, uuidv7()],
      ),
    );
    const jailed = await call(app, founder, 'POST', `/v1/projects/${projectId}/launch`, {
      ticker: 'FROGE',
      quotedCostCents: 50_000,
    });
    expect(jailed.status).toBe(403);
    expect(err(jailed.body).code).toBe('JAILED');
    await createDb().withConnection((c) =>
      c.query(`DELETE FROM player_jail WHERE user_id = $1`, [founder.sub]),
    );
    const tk = `F${uuidv7().replace(/-/g, '').slice(-6).toUpperCase()}`;
    const live = await call(app, founder, 'POST', `/v1/projects/${projectId}/launch`, {
      ticker: tk,
      quotedCostCents: 50_000,
    });
    expect(live.status, JSON.stringify(live.body)).toBe(200);
    expect(live.body).toMatchObject({ status: 'live', treasuryCents: 25_000 });
    expect(live.body.coinId).toMatch(/^[0-9a-f-]{36}$/);

    const detail = await call(app, stranger, 'GET', `/v1/projects/${projectId}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ payrollCentsPerWeek: 20_000, vcStakes: [] });
    expect((detail.body.members as Array<{ role: string }>).map((m) => m.role)).toEqual([
      'founder',
      'dev',
    ]);
    expect(detail.body.hires).toHaveLength(1);
    expect(typeof detail.body.nextPayrollAt).toBe('string');

    const ev = await call(app, stranger, 'GET', `/v1/projects/${projectId}/events?limit=2`);
    expect(ev.status).toBe(200);
    const events = ev.body.events as Array<{ eventId: string; cashDeltaCents: number }>;
    expect(events[0]).toMatchObject({ eventId: 'proj_launched', cashDeltaCents: -50_000 });
    expect(typeof ev.body.nextCursor).toBe('string');
    const page2 = await call(
      app,
      stranger,
      'GET',
      `/v1/projects/${projectId}/events?limit=50&cursor=${ev.body.nextCursor as string}`,
    );
    const ids = (page2.body.events as Array<{ eventId: string }>).map((e) => e.eventId);
    expect(ids).toContain('proj_founded');
    expect(page2.body.nextCursor).toBeNull();

    const missing = await call(app, stranger, 'GET', `/v1/projects/${uuidv7()}/events`);
    expect(missing.status).toBe(404);
  });

  it('fire and quit: DELETE members -> 204; founder cannot be removed', async () => {
    const p = await call(app, founder, 'POST', '/v1/projects', { kind: 'memecoin' });
    const projectId = p.body.projectId as string;
    const member = await devAuth(app);
    const o = await call(app, founder, 'POST', `/v1/projects/${projectId}/offers`, {
      userId: member.sub,
      role: 'mod',
      salaryCentsPerWeek: 10_000,
    });
    await call(app, member, 'POST', `/v1/project-offers/${o.body.offerId as string}/accept`);
    const self = await call(
      app,
      founder,
      'DELETE',
      `/v1/projects/${projectId}/members/${founder.sub}`,
    );
    expect(self.status).toBe(409);
    expect(err(self.body).details.reason).toBe('founder');
    const nope = await call(
      app,
      stranger,
      'DELETE',
      `/v1/projects/${projectId}/members/${member.sub}`,
    );
    expect(nope.status).toBe(403);
    const fire = await call(
      app,
      founder,
      'DELETE',
      `/v1/projects/${projectId}/members/${member.sub}`,
    );
    expect(fire.status).toBe(204);
    const gone = await call(
      app,
      founder,
      'DELETE',
      `/v1/projects/${projectId}/members/${member.sub}`,
    );
    expect(gone.status).toBe(404);
  });

  it('project task: start -> 409 task_not_finished -> complete -> worked; founder 403; project_limit', async () => {
    const boss = await devAuth(app);
    await giveCash(boss, 10_000_000);
    const p = await call(app, boss, 'POST', '/v1/projects', { kind: 'memecoin' });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    const projectId = p.body.projectId as string;
    const member = await devAuth(app);
    const o = await call(app, boss, 'POST', `/v1/projects/${projectId}/offers`, {
      userId: member.sub,
      role: 'kol',
      salaryCentsPerWeek: 10_000,
    });
    await call(app, member, 'POST', `/v1/project-offers/${o.body.offerId as string}/accept`);
    const f = await call(app, boss, 'POST', `/v1/projects/${projectId}/tasks`);
    expect(f.status).toBe(403);
    expect(err(f.body).details.reason).toBe('founder');
    const t = await call(app, member, 'POST', `/v1/projects/${projectId}/tasks`);
    expect(t.status).toBe(201);
    expect(Object.keys(t.body).sort()).toEqual(['endsAt', 'projectId', 'startedAt', 'taskId']);
    const early = await call(
      app,
      member,
      'POST',
      `/v1/projects/${projectId}/tasks/${t.body.taskId as string}/complete`,
    );
    expect(early.status).toBe(409);
    expect(err(early.body).details).toMatchObject({ reason: 'task_not_finished' });
    await createDb().withConnection((c) =>
      c.query(`UPDATE project_tasks SET ends_at = now() - interval '1 second' WHERE task_id = $1`, [
        t.body.taskId,
      ]),
    );
    const done = await call(
      app,
      member,
      'POST',
      `/v1/projects/${projectId}/tasks/${t.body.taskId as string}/complete`,
    );
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ worked: true, taskId: t.body.taskId });
    expect(done.body.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The limit (2) counts founder roles.
    expect((await call(app, boss, 'POST', '/v1/projects', { kind: 'memecoin' })).status).toBe(201);
    const extra = await call(app, boss, 'POST', '/v1/projects', { kind: 'memecoin' });
    expect(extra.status).toBe(409);
    expect(err(extra.body).details).toMatchObject({ reason: 'project_limit', max: 2 });
  });
});
