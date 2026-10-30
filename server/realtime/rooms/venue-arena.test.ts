/**
 * Debate Arena activity (unlock A6): in the `ratio_arena` venue a live beef
 * participant's emotes and talking spans are counted for the arena crowd (a
 * talking span is capped per span); other venues and players not in a live
 * match count nothing; beef_update / beef_result from the presence channel
 * are relayed to the room.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { VenueRoom } from './venue.js';
import { buildContext } from '../../application/context.js';
import { markLive } from '../../application/beef-activity.js';
import { beefConfig } from '../../application/beef-rules.js';

const USER = `arena-${Date.now()}`;
vi.mock('../player.js', async (orig) => {
  const real = await orig<typeof import('../player.js')>();
  const { PlayerState: PS } = await import('../../../contract/realtime/states.js');
  return {
    ...real,
    authenticateJoin: async () => USER,
    loadPlayerState: async (id: string) => Object.assign(new PS(), { userId: id }),
  };
});
vi.mock('../ban-guard.js', () => ({
  BanGuard: class {
    attach = async (): Promise<void> => undefined;
    detach = async (): Promise<void> => undefined;
    track = (): void => undefined;
    untrack = (): void => undefined;
    confirm = async (): Promise<void> => undefined;
  },
}));

const ctx = buildContext();
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 200));

async function join(
  venueId: string,
): Promise<{ room: VenueRoom; call: (m: string, msg: unknown) => void }> {
  const room = new VenueRoom();
  const r = room as unknown as Record<string, unknown>;
  r.setSimulationInterval = () => undefined;
  r.presence = { subscribe: async () => undefined, unsubscribe: async () => undefined };
  await room.onCreate({ venueId });
  const client = { sessionId: 's1', send: () => undefined };
  await room.onJoin(client as never, {});
  const call = (m: string, msg: unknown): void =>
    (r[m] as (c: unknown, x: unknown) => void).call(room, client, msg);
  return { room, call };
}

afterAll(async () => {
  await ctx.redis.main.del(`beef:live:${USER}`, 'beef:act:m-arena');
});

describe('Debate Arena activity', () => {
  it('counts a live participant: emotes and capped talking spans', async () => {
    await markLive(ctx.redis.main, 'm-arena', [USER], 120);
    const { call } = await join('ratio_arena');
    let now = 5_000_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      call('handleEmote', { emoteId: 'loco_idle' });
      call('handleTalking', { on: true });
      now += 12_000;
      call('handleTalking', { on: false });
      call('handleTalking', { on: true });
      now += 500_000; // one very long span: capped
      call('handleTalking', { on: false });
    } finally {
      spy.mockRestore();
    }
    await settle();
    const h = await ctx.redis.main.hgetall('beef:act:m-arena');
    expect(Number(h[`${USER}:emote`])).toBe(1);
    expect(Number(h[`${USER}:talk`])).toBe(12 + beefConfig(ctx).crowd.maxTalkSpanSeconds);
  });

  it('relays beef messages from the presence channel to the room', async () => {
    const { room } = await join('ratio_arena');
    const seen: Array<[string, unknown]> = [];
    (room as unknown as { broadcast: (t: string, p: unknown) => void }).broadcast = (t, p) =>
      seen.push([t, p]);
    const onBeef = (room as unknown as { onBeef: (d: unknown) => void }).onBeef;
    onBeef({ type: 'beef_update', payload: { matchId: 'x', status: 'voting' } });
    onBeef({ type: 'something_else', payload: {} });
    expect(seen).toEqual([['beef_update', { matchId: 'x', status: 'voting' }]]);
  });

  it('counts nothing in other venues', async () => {
    await ctx.redis.main.del('beef:act:m-arena');
    await markLive(ctx.redis.main, 'm-arena', [USER], 120);
    const { call } = await join('timeline_square');
    call('handleEmote', { emoteId: 'loco_idle' });
    await settle();
    expect(await ctx.redis.main.hgetall('beef:act:m-arena')).toEqual({});
  });
});
