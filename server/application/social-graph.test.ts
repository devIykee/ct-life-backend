/**
 * DM delivery tests.
 *
 * sendDm must push exactly one contract-shaped `dm` to the recipient over
 * the realtime bus, and nothing at all for a blocked pair.
 */
import { Pool } from 'pg';
import type { Redis } from 'ioredis';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config as loadDotenv } from 'dotenv';

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { DmMessage } from '../../contract/realtime/messages.js';
import { subscribeUserMessages, type UserMessage } from './realtime-bus.js';
import { sendDm } from './social-graph.js';

loadDotenv({ path: process.cwd() + '/.env' });

_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let alice: string;
let bob: string;
let sub: Redis;
let received: UserMessage[] = [];

/** Pub/sub is async; give the subscriber a moment to drain. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 150));

beforeAll(async () => {
  alice = uuidv7();
  bob = uuidv7();
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2), ($3, $4)`, [
    alice,
    `dmAlice-${alice}`,
    bob,
    `dmBob-${bob}`,
  ]);
  const ctx = buildContext();
  sub = subscribeUserMessages(ctx.redis.main, (msg) => {
    if (msg.userId === bob || msg.userId === alice) received.push(msg);
  });
  await settle();
});

afterAll(async () => {
  await sub.quit();
  await pool.end();
});

beforeEach(async () => {
  received = [];
  await pool.query(
    `DELETE FROM blocks WHERE blocker_user_id IN ($1, $2) OR blocked_user_id IN ($1, $2)`,
    [alice, bob],
  );
});

describe('sendDm realtime push', () => {
  it('publishes exactly one contract-shaped dm to the recipient', async () => {
    const ctx = buildContext();
    const row = await sendDm(ctx, alice, bob, 'gm');
    await settle();

    expect(received).toHaveLength(1);
    const msg = received[0]!;
    expect(msg.userId).toBe(bob);
    expect(msg.type).toBe('dm');
    const payload = DmMessage.parse(msg.payload);
    expect(payload).toEqual({
      messageId: row.messageId,
      fromUserId: alice,
      text: 'gm',
      at: Date.parse(row.at),
    });
  });

  it('sends nothing to a blocked pair', async () => {
    const ctx = buildContext();
    await pool.query(`INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2)`, [
      bob,
      alice,
    ]);
    await expect(sendDm(ctx, alice, bob, 'gm')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await settle();
    expect(received).toHaveLength(0);
  });
});
