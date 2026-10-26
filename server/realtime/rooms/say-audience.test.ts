/**
 * `say` fan-out: nobody who blocked the speaker (or was blocked by them) hears
 * it, a muted speaker is told and heard by no one, and a policy failure drops
 * the message instead of sending it to everyone.
 */
import { describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { VenueRoom } from './venue.js';
import { StreetRoom } from './street.js';
import { HomeRoom } from './home.js';
import { PlayerState } from '../../../contract/realtime/states.js';
import { createDb } from '../../shared/db/pool.js';
import { uuidv7 } from '../../shared/domain/uuid.js';

loadDotenv({ path: process.cwd() + '/.env' });
const db = createDb();

interface Fake {
  sessionId: string;
  got: Array<[string, unknown]>;
  send(type: string, msg: unknown): void;
}
const fake = (sessionId: string): Fake => ({
  sessionId,
  got: [],
  send(type, msg) {
    this.got.push([type, msg]);
  },
});
async function user(): Promise<string> {
  const id = uuidv7();
  await db.withConnection((c) =>
    c.query('INSERT INTO users (id, wallet) VALUES ($1, $2)', [id, `w-${id}`]),
  );
  return id;
}

for (const kind of ['venue', 'street'] as const) {
  describe(`${kind} say audience`, () => {
    it('skips blockers, tells a muted speaker', async () => {
      const [speaker, friend, blocker, blockedByMe] = [
        await user(),
        await user(),
        await user(),
        await user(),
      ];
      await db.withConnection(async (c) => {
        await c.query(
          'INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ($1,$2),($2,$1)',
          [blocker, speaker],
        );
        await c.query(
          'INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ($1,$2),($2,$1)',
          [speaker, blockedByMe],
        );
      });
      const clients = [fake('s-speaker'), fake('s-friend'), fake('s-blocker'), fake('s-mine')];
      const ids: Record<string, string> = {
        's-speaker': speaker,
        's-friend': friend,
        's-blocker': blocker,
        's-mine': blockedByMe,
      };
      const room: any = kind === 'venue' ? new VenueRoom() : new StreetRoom();
      Object.defineProperty(room, 'clients', { value: clients, configurable: true });
      if (kind === 'venue') {
        room.state = {
          players: new Map(
            clients.map((c) => [
              c.sessionId,
              Object.assign(new PlayerState(), { userId: ids[c.sessionId] }),
            ]),
          ),
        };
      } else {
        room.sessions = new Map(clients.map((c) => [c.sessionId, { userId: ids[c.sessionId] }]));
      }
      await room.deliverSay(clients[0], speaker, { text: 'hi' });
      expect(clients[0]!.got).toHaveLength(0);
      expect(clients[1]!.got.map((g) => g[0])).toEqual(['said']);
      expect(clients[2]!.got).toHaveLength(0);
      expect(clients[3]!.got).toHaveLength(0);

      await db.withConnection((c) =>
        c.query(
          "INSERT INTO user_moderation (user_id, muted_until) VALUES ($1, now() + interval '1 hour')",
          [speaker],
        ),
      );
      await room.deliverSay(clients[0], speaker, { text: 'again' });
      expect(clients[0]!.got).toEqual([['rejected', { type: 'say', code: 'ACCOUNT_MUTED' }]]);
      expect(clients[1]!.got).toHaveLength(1);
    });
  });
}

describe('ban kicks live sessions', () => {
  it('street, venue and home rooms leave every session of the banned user and only theirs', () => {
    const mk = (sessionId: string) => ({
      sessionId,
      left: [] as Array<[number, string]>,
      leave(code: number, reason: string) {
        this.left.push([code, reason]);
      },
    });
    for (const kind of ['street', 'venue', 'home'] as const) {
      const clients = [mk('a1'), mk('a2'), mk('b1')];
      const owner: Record<string, string> = { a1: 'bad', a2: 'bad', b1: 'good' };
      const room: any =
        kind === 'street' ? new StreetRoom() : kind === 'venue' ? new VenueRoom() : new HomeRoom();
      Object.defineProperty(room, 'clients', { value: clients, configurable: true });
      if (kind === 'street') {
        room.sessions = new Map(clients.map((c) => [c.sessionId, { userId: owner[c.sessionId] }]));
      } else if (kind === 'venue') {
        room.state = {
          players: new Map(clients.map((c) => [c.sessionId, { userId: owner[c.sessionId] }])),
        };
      } else {
        room.userBySession = new Map(clients.map((c) => [c.sessionId, owner[c.sessionId]]));
      }
      room.onBan({ userId: 'bad' });
      expect(clients[0]!.left, kind).toEqual([[4003, 'ACCOUNT_BANNED']]);
      expect(clients[1]!.left, kind).toHaveLength(1);
      expect(clients[2]!.left, kind).toHaveLength(0);
      room.onBan({ nope: true }); // malformed events are ignored
    }
  });
});
