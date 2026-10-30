/**
 * project_hq room: a VenueRoom on the hackathon_house layout, one per
 * project. Members always enter, visitors only while a member is inside and
 * are shown out after the last member; the API sees who is inside through
 * Redis; a long enough member visit logs an HQ shift (project_work_log).
 * Driven directly (no matchmaker), like home.test.ts.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { LocalPresence } from 'colyseus';
import { Encoder, type Schema } from '@colyseus/schema';
import { buildContext, _resetContextForTests } from '../../application/context.js';
import { _resetConfigForTests } from '../../shared/config/config.js';
import { uuidv7 } from '../../shared/domain/uuid.js';
import { createJwtIssuer } from '../../shared/auth/jwt.js';
import { foundProject } from '../../application/projects.js';
import { acceptOffer, createOffer } from '../../application/project-offers.js';
import { hqPresenceKey } from '../../application/project-hq.js';

loadDotenv({ path: process.cwd() + '/.env' });
const savedCaps = process.env.CAPABILITIES_ON;
process.env.CAPABILITIES_ON = 'builder,projectHq';
_resetConfigForTests();
_resetContextForTests();

const { ProjectHqRoom } = await import('./project-hq.js');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const founder = uuidv7();
const dev = uuidv7();
const visitor = uuidv7();
let projectId = '';

interface FakeClient {
  sessionId: string;
  left: number | null;
  send: (t: string, p: unknown) => void;
  leave: (code: number) => void;
}
function fakeClient(sessionId: string): FakeClient {
  const c: FakeClient = {
    sessionId,
    left: null,
    send: () => undefined,
    leave: (code) => {
      c.left = code;
    },
  };
  return c;
}
const token = (userId: string): Promise<string> =>
  createJwtIssuer().signAccess(userId, `hq-${userId}`, false);

async function newRoom(): Promise<Record<string, any>> {
  const room = new ProjectHqRoom() as unknown as Record<string, any>;
  room.presence = new LocalPresence();
  room.setSimulationInterval = () => undefined;
  room.clock = { setInterval: () => undefined, clear: () => undefined };
  return room;
}

beforeAll(async () => {
  for (const id of [founder, dev, visitor]) {
    await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [id, `hq-${id}`]);
  }
  await pool.query(
    `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 1000000)
     ON CONFLICT (user_id) DO UPDATE SET cash_cents = 1000000`,
    [founder],
  );
  const ctx = buildContext();
  const p = await foundProject(ctx, founder, 'memecoin');
  projectId = p.projectId;
  const o = await createOffer(ctx, founder, projectId, {
    userId: dev,
    role: 'dev',
    salaryCentsPerWeek: 20_000,
  });
  await acceptOffer(ctx, dev, o.offerId);
});

afterAll(async () => {
  await pool.query(`DELETE FROM projects WHERE owner_user_id = $1`, [founder]);
  await buildContext().redis.main.del(hqPresenceKey(projectId));
  await pool.end();
  if (savedCaps === undefined) delete process.env.CAPABILITIES_ON;
  else process.env.CAPABILITIES_ON = savedCaps;
});

describe('ProjectHqRoom', () => {
  it('members_only until a member is in; HQ shift; visitors shown out after the last member', async () => {
    const ctx = buildContext();
    const room = await newRoom();
    await room.onCreate({ projectId });
    new Encoder(room.state as Schema);
    expect(room.roomId).toBe(`hq_${projectId}`);
    expect(room.state.venueId).toBe('hackathon_house');
    expect(room.maxClients).toBe(12);

    const v = fakeClient('s-visitor');
    await expect(room.onJoin(v, { token: await token(visitor) })).rejects.toMatchObject({
      code: 4403,
      message: 'members_only',
    });

    const d = fakeClient('s-dev');
    room.clients.push(d);
    await room.onJoin(d, { token: await token(dev) });
    expect(await ctx.redis.main.smembers(hqPresenceKey(projectId))).toEqual([dev]);

    room.clients.push(v);
    await room.onJoin(v, { token: await token(visitor) });
    expect(room.state.players.size).toBe(2);

    // Eleven minutes in: the member's week counts as worked (hq_shift).
    const start = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(start + 11 * 60_000);
    try {
      await room.tick();
    } finally {
      spy.mockRestore();
    }
    const log = await pool.query<{ source: string }>(
      `SELECT source FROM project_work_log WHERE project_id = $1 AND user_id = $2`,
      [projectId, dev],
    );
    expect(log.rows.map((r) => r.source)).toEqual(['hq_shift']);

    room.onLeave(d);
    expect(v.left).toBe(4403);
    await new Promise((r) => setTimeout(r, 100));
    expect(await ctx.redis.main.exists(hqPresenceKey(projectId))).toBe(0);
    await room.onDispose();
  });

  it('refuses a bad project id', async () => {
    const room = await newRoom();
    await expect(room.onCreate({ projectId: 'nope' })).rejects.toMatchObject({
      code: 4404,
      message: 'not_found',
    });
  });

  it('is closed while the projectHq capability is off', async () => {
    process.env.CAPABILITIES_ON = 'builder';
    _resetConfigForTests();
    try {
      const room = await newRoom();
      await expect(room.onCreate({ projectId })).rejects.toMatchObject({
        code: 4503,
        message: 'capability_off',
      });
    } finally {
      process.env.CAPABILITIES_ON = 'builder,projectHq';
      _resetConfigForTests();
    }
  });
});
