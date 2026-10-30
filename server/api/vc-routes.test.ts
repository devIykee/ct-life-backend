/**
 * VC Row routes over HTTP: the `vc` capability gate and the contract shapes
 * (`VcOffer`, `VcDeal`, `vcStakes`) the client parses.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { Keypair } from '@solana/web3.js';
import { buildServer } from './main.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { createDb } from '../shared/db/pool.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { _resetContextForTests, buildContext } from '../application/context.js';
import { offerForProject } from '../application/vc-row.js';
import type { Rng } from '../shared/domain/rng.js';

loadDotenv({ path: process.cwd() + '/.env' });

type App = Awaited<ReturnType<typeof buildServer>>['app'];
interface User {
  sub: string;
  token: string;
}
const savedCaps = process.env.CAPABILITIES_ON;

const yes: Rng = {
  int: () => 0,
  float: () => 0,
  chance: () => true,
  pick: <T>(xs: readonly T[]) => xs[0] as T,
  weighted: <T>(xs: readonly T[]) => xs[0] as T,
  normal: () => 0,
};

async function boot(caps: string): Promise<{ app: App; stop: () => Promise<void> }> {
  process.env.CAPABILITIES_ON = caps;
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
    headers: { 'idempotency-key': `vc-${uuidv7()}` },
    payload: { wallet: Keypair.generate().publicKey.toBase58() },
  });
  const b = r.json() as { id: string; accessToken: string };
  return { sub: b.id, token: b.accessToken };
}

async function call(
  app: App,
  u: User,
  method: 'GET' | 'POST',
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
  return { status: r.statusCode, body: r.json() as Record<string, unknown> };
}

afterAll(() => {
  if (savedCaps === undefined) delete process.env.CAPABILITIES_ON;
  else process.env.CAPABILITIES_ON = savedCaps;
  _resetConfigForTests();
  _resetContextForTests();
});

describe('vc capability', () => {
  it('off: every VC route answers 503 CAPABILITY_OFF {capability: vc}', async () => {
    const { app, stop } = await boot('builder');
    try {
      const u = await devAuth(app);
      const id = uuidv7();
      for (const [method, url] of [
        ['GET', `/v1/projects/${id}/vc-offers`],
        ['POST', `/v1/vc-offers/${id}/accept`],
        ['POST', `/v1/vc-offers/${id}/decline`],
        ['GET', '/v1/vc-row/deals'],
      ] as const) {
        const r = await call(app, u, method, url, method === 'GET' ? undefined : {});
        expect(r.status, url).toBe(503);
        expect(r.body.error).toMatchObject({
          code: 'CAPABILITY_OFF',
          details: { capability: 'vc' },
        });
      }
    } finally {
      await stop();
    }
  }, 30_000);

  it('on: list term sheets, accept, see the stake and the board', async () => {
    const { app, stop } = await boot('builder,vc');
    try {
      const founder = await devAuth(app);
      const dev = await devAuth(app);
      const db = createDb();
      await db.withConnection((c) =>
        c.query(
          `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 10000000)
           ON CONFLICT (user_id) DO UPDATE SET cash_cents = EXCLUDED.cash_cents`,
          [founder.sub],
        ),
      );
      const p = await call(app, founder, 'POST', '/v1/projects', { kind: 'memecoin' });
      const projectId = p.body.projectId as string;
      const o = await call(app, founder, 'POST', `/v1/projects/${projectId}/offers`, {
        userId: dev.sub,
        role: 'dev',
        salaryCentsPerWeek: 20_000,
      });
      await call(app, dev, 'POST', `/v1/project-offers/${o.body.offerId as string}/accept`);
      await db.withConnection((c) =>
        c.query(
          `UPDATE projects SET created_at = now() - interval '3 days' WHERE project_id = $1`,
          [projectId],
        ),
      );
      const tk = `W${uuidv7().replace(/-/g, '').slice(-6).toUpperCase()}`;
      const live = await call(app, founder, 'POST', `/v1/projects/${projectId}/launch`, {
        ticker: tk,
        quotedCostCents: 50_000,
      });
      expect(live.status, JSON.stringify(live.body)).toBe(200);
      await db.withConnection((c) =>
        c.query(
          `UPDATE projects SET launched_at = now() - interval '2 days' WHERE project_id = $1`,
          [projectId],
        ),
      );
      const made = await offerForProject(buildContext(), projectId, yes, new Date());
      expect(made).not.toBeNull();

      const notMine = await call(app, dev, 'GET', `/v1/projects/${projectId}/vc-offers`);
      expect(notMine.status).toBe(403);
      const list = await call(app, founder, 'GET', `/v1/projects/${projectId}/vc-offers`);
      expect(list.status).toBe(200);
      const offers = list.body.offers as Array<Record<string, unknown>>;
      expect(Object.keys(offers[0]!).sort()).toEqual(
        [
          'offerId',
          'projectId',
          'vcArchetypeId',
          'investCents',
          'equityBps',
          'unlockAt',
          'status',
          'expiresAt',
        ].sort(),
      );
      const acc = await call(app, founder, 'POST', `/v1/vc-offers/${made!.offerId}/accept`);
      expect(acc.status).toBe(200);
      expect(acc.body).toMatchObject({ status: 'accepted', investCents: made!.investCents });
      const again = await call(app, founder, 'POST', `/v1/vc-offers/${made!.offerId}/decline`);
      expect(again.status).toBe(409);

      const detail = await call(app, founder, 'GET', `/v1/projects/${projectId}`);
      expect(detail.body.vcStakes).toEqual([
        {
          vcArchetypeId: 'vc',
          equityBps: made!.equityBps,
          investedCents: made!.investCents,
          unlockAt: acc.body.unlockAt,
        },
      ]);
      const board = await call(app, founder, 'GET', '/v1/vc-row/deals?limit=1');
      expect(board.status).toBe(200);
      const deals = board.body.deals as Array<Record<string, unknown>>;
      expect(deals).toHaveLength(1);
      expect(Object.keys(deals[0]!).sort()).toEqual(
        [
          'projectId',
          'projectName',
          'vcArchetypeId',
          'investCents',
          'equityBps',
          'status',
          'at',
        ].sort(),
      );
      expect(board.body).toHaveProperty('nextCursor');
    } finally {
      await stop();
    }
  }, 30_000);
});
