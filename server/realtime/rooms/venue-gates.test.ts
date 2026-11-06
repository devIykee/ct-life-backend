/**
 * Venue entry gates are enforced on join (security fix): a player who fails
 * the venues.json `access` gate is refused by the room itself, not only by
 * GET /v1/venues/{venueId}/access, and a gated venue whose check errors is
 * refused (fail closed). Open venues never look the player up.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { ServerError } from 'colyseus';
import { uuidv7 } from '../../shared/domain/uuid.js';
import { MARINA_GATE_CENTS } from '../../application/venues-gating.js';

const join = vi.hoisted(() => ({ userId: '', failAccess: false, accessCalls: 0 }));

vi.mock('../player.js', async (orig) => {
  const real = await orig<typeof import('../player.js')>();
  const { PlayerState: PS } = await import('../../../contract/realtime/states.js');
  return {
    ...real,
    authenticateJoin: async () => join.userId,
    loadPlayerState: async (id: string) => Object.assign(new PS(), { userId: id }),
  };
});

vi.mock('../../application/venues-gating.js', async (orig) => {
  const real = await orig<typeof import('../../application/venues-gating.js')>();
  return {
    ...real,
    getVenueAccess: async (...args: Parameters<typeof real.getVenueAccess>) => {
      join.accessCalls++;
      if (join.failAccess) throw new Error('connection terminated unexpectedly');
      return real.getVenueAccess(...args);
    },
  };
});

const { VenueRoom, VENUE_GATE_JOIN_ERRORS } = await import('./venue.js');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
afterAll(async () => {
  await pool.end();
});
beforeEach(() => {
  join.failAccess = false;
  join.accessCalls = 0;
});

async function player(prefix: string, cashCents: number): Promise<string> {
  const id = uuidv7();
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [
    id,
    `venueGate-${prefix}-${id}`,
  ]);
  await pool.query(
    `INSERT INTO balances (user_id, cash_cents, debt_cents) VALUES ($1, $2, 0)
     ON CONFLICT (user_id) DO UPDATE SET cash_cents = $2, debt_cents = 0`,
    [id, cashCents],
  );
  return id;
}

/** Join `venueId` as `userId`; resolves with the room, rejects with the join error. */
async function enter(venueId: string, userId: string): Promise<InstanceType<typeof VenueRoom>> {
  join.userId = userId;
  const room = new VenueRoom();
  const r = room as unknown as Record<string, unknown>;
  r.setSimulationInterval = () => undefined;
  await room.onCreate({ venueId });
  await room.onJoin({ sessionId: `s-${userId}`, send: () => undefined } as never, {});
  return room;
}

async function refusal(venueId: string, userId: string): Promise<ServerError> {
  try {
    await enter(venueId, userId);
  } catch (e) {
    expect(e).toBeInstanceOf(ServerError);
    return e as ServerError;
  }
  throw new Error(`join to ${venueId} was not refused`);
}

describe('venue gates on join', () => {
  it('refuses a player below the net-worth bar with 4403 NET_WORTH_TOO_LOW', async () => {
    const poor = await player('poor', MARINA_GATE_CENTS - 1);
    for (const venueId of ['yacht_club', 'dubai_marina', 'penthouse_row']) {
      const e = await refusal(venueId, poor);
      expect(e.code).toBe(VENUE_GATE_JOIN_ERRORS.refused);
      expect(e.message).toBe('NET_WORTH_TOO_LOW');
    }
  });

  it('admits a player at the bar, and a penthouse resident with no money', async () => {
    const rich = await player('rich', MARINA_GATE_CENTS);
    const room = await enter('yacht_club', rich);
    expect([...room.state.players.values()].map((p) => p.userId)).toEqual([rich]);

    const resident = await player('resident', 0);
    await pool.query(
      `INSERT INTO homes (home_id, owner_user_id, kind, rent_cents_per_week, status)
       VALUES ($1, $2, 'penthouse', 150000, 'active')`,
      [`home-${uuidv7()}`, resident],
    );
    const row = await enter('penthouse_row', resident);
    expect(row.state.players.size).toBe(1);
    await expect(refusal('yacht_club', resident)).resolves.toMatchObject({
      message: 'NET_WORTH_TOO_LOW',
    });
  });

  it('refuses the VIP Lounge without membership and the Barn unless jailed', async () => {
    const rich = await player('richNoInvite', MARINA_GATE_CENTS * 10);
    expect((await refusal('cabal_lounge', rich)).message).toBe('NOT_A_MEMBER');
    expect((await refusal('sybil_barn', rich)).message).toBe('NOT_JAILED');
  });

  it('fails closed: a gated venue whose check errors refuses with 4503', async () => {
    const rich = await player('richDbDown', MARINA_GATE_CENTS * 10);
    join.failAccess = true;
    const e = await refusal('yacht_club', rich);
    expect(e.code).toBe(VENUE_GATE_JOIN_ERRORS.unavailable);
    expect(e.message).toBe('VENUE_GATE_UNAVAILABLE');
  });

  it('open venues never look the player up, so a database error does not block them', async () => {
    const anyone = await player('open', 0);
    join.failAccess = true;
    for (const venueId of ['checker_kiosk', 'timeline_square']) {
      const room = await enter(venueId, anyone);
      expect(room.state.players.size).toBe(1);
    }
    expect(join.accessCalls).toBe(0);
  });
});
