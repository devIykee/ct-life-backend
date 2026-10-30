/**
 * POST /projects/{id}/hq/visit over HTTP: the `projectHq` gate, the ticket
 * shape, and members_only for a visitor while no member is inside.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { Keypair } from '@solana/web3.js';
import { buildServer } from './main.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { createDb } from '../shared/db/pool.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { _resetContextForTests, buildContext } from '../application/context.js';
import { hqPresenceKey, setHqMembersPresent } from '../application/project-hq.js';

loadDotenv({ path: process.cwd() + '/.env' });

type App = Awaited<ReturnType<typeof buildServer>>['app'];
interface User {
  sub: string;
  token: string;
}
const savedCaps = process.env.CAPABILITIES_ON;

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
    headers: { 'idempotency-key': `hq-${uuidv7()}` },
    payload: { wallet: Keypair.generate().publicKey.toBase58() },
  });
  const b = r.json() as { id: string; accessToken: string };
  return { sub: b.id, token: b.accessToken };
}

async function visit(
  app: App,
  u: User,
  projectId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await app.inject({
    method: 'POST',
    url: `/v1/projects/${projectId}/hq/visit`,
    headers: { authorization: `Bearer ${u.token}`, 'idempotency-key': uuidv7() },
    payload: {},
  });
  return { status: r.statusCode, body: r.json() as Record<string, unknown> };
}

afterAll(() => {
  if (savedCaps === undefined) delete process.env.CAPABILITIES_ON;
  else process.env.CAPABILITIES_ON = savedCaps;
  _resetConfigForTests();
  _resetContextForTests();
});

describe('POST /projects/{id}/hq/visit', () => {
  it('503 while projectHq is off', async () => {
    const { app, stop } = await boot('builder');
    try {
      const u = await devAuth(app);
      const r = await visit(app, u, uuidv7());
      expect(r.status).toBe(503);
      expect(r.body.error).toMatchObject({
        code: 'CAPABILITY_OFF',
        details: { capability: 'projectHq' },
      });
    } finally {
      await stop();
    }
  }, 30_000);

  it('a member gets a ticket; a visitor only while a member is inside; 404 for no project', async () => {
    const { app, stop } = await boot('builder,projectHq');
    try {
      const founder = await devAuth(app);
      const stranger = await devAuth(app);
      await createDb().withConnection((c) =>
        c.query(
          `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 1000000)
           ON CONFLICT (user_id) DO UPDATE SET cash_cents = EXCLUDED.cash_cents`,
          [founder.sub],
        ),
      );
      const p = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: { authorization: `Bearer ${founder.token}`, 'idempotency-key': uuidv7() },
        payload: { kind: 'memecoin' },
      });
      const projectId = (p.json() as { projectId: string }).projectId;

      const t = await visit(app, founder, projectId);
      expect(t.status).toBe(200);
      expect(Object.keys(t.body).sort()).toEqual(
        ['expiresAt', 'projectId', 'roomId', 'roomName', 'venueId'].sort(),
      );
      expect(t.body).toMatchObject({
        roomName: 'project_hq',
        roomId: `hq_${projectId}`,
        venueId: 'hackathon_house',
        projectId,
      });

      const shut = await visit(app, stranger, projectId);
      expect(shut.status).toBe(403);
      expect(shut.body.error).toMatchObject({
        code: 'FORBIDDEN',
        details: { reason: 'members_only' },
      });

      await setHqMembersPresent(buildContext(), projectId, [founder.sub]);
      expect((await visit(app, stranger, projectId)).status).toBe(200);
      await buildContext().redis.main.del(hqPresenceKey(projectId));

      expect((await visit(app, founder, uuidv7())).status).toBe(404);
    } finally {
      await stop();
    }
  }, 30_000);
});
