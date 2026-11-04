import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AppContext } from './context.js';
import { createFcmTransport, sendPush, type TransportMessage } from './push-delivery.js';

// These tests exercise payload construction, not SQL transaction behavior or a live FCM account.
vi.mock('../shared/db/uow.js', () => ({ runInTransaction: async () => 'ok' }));
vi.mock('../shared/logger/logger.js', () => {
  const logger = { child: () => logger, debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: () => logger };
});

describe('push recipient binding', () => {
  it('binds successive messages to their server-selected recipients even if the device token is reused', async () => {
    const send = vi.fn(async (_message: TransportMessage) => ({ ok: true as const }));
    for (const recipient of ['player-before-signout', 'player-after-signin']) {
      const query = vi
        .fn()
        .mockResolvedValueOnce({ rows: [] }) // default preferences
        .mockResolvedValueOnce({
          rows: [{ device_id: 'device', fcm_token: 'reused-device-token' }],
        })
        .mockResolvedValueOnce({ rows: [] }); // delivery log update
      const ctx = {
        db: {
          withConnection: async (fn: (client: { query: typeof query }) => unknown) => fn({ query }),
        },
      } as unknown as AppContext;
      const outcome = await sendPush(
        ctx,
        recipient,
        'streak_ending',
        { title: 'T', body: 'B', deepLink: 'ctlife://quests' },
        { dedupeKey: 'test', now: new Date('2091-01-01T12:00:00Z'), transport: { send } },
      );
      expect(outcome).toBe('sent');
    }
    expect(send.mock.calls.map(([message]) => message)).toEqual([
      {
        token: 'reused-device-token',
        title: 'T',
        body: 'B',
        data: {
          type: 'streak_ending',
          deep_link: 'ctlife://quests',
          recipient_id: 'player-before-signout',
        },
      },
      {
        token: 'reused-device-token',
        title: 'T',
        body: 'B',
        data: {
          type: 'streak_ending',
          deep_link: 'ctlife://quests',
          recipient_id: 'player-after-signin',
        },
      },
    ]);
  });

  it('preserves native notification fields while forwarding the recipient in the HTTP v1 data map', async () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const requests: RequestInit[] = [];
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/token')) {
        return new Response(JSON.stringify({ access_token: 'fixture-access', expires_in: 3600 }));
      }
      requests.push(init ?? {});
      return new Response(JSON.stringify({ name: 'projects/test/messages/1' }));
    }) as unknown as typeof fetch;
    const transport = createFcmTransport(
      {
        fcmProjectId: 'test',
        fcmServiceAccountPath: '',
        fcmServiceAccountJson: JSON.stringify({
          client_email: 'fixture@test.invalid',
          private_key: privateKey,
        }),
      },
      fetchFn,
    )!;
    expect(
      await transport.send({
        token: 'fixture-device',
        title: 'T',
        body: 'B',
        data: {
          type: 'streak_ending',
          deep_link: 'ctlife://quests',
          recipient_id: 'server-recipient',
        },
      }),
    ).toEqual({ ok: true });
    expect(JSON.parse(String(requests[0]?.body))).toEqual({
      message: {
        token: 'fixture-device',
        notification: { title: 'T', body: 'B' },
        android: { priority: 'HIGH' },
        data: {
          type: 'streak_ending',
          deep_link: 'ctlife://quests',
          recipient_id: 'server-recipient',
        },
      },
    });
  });
});
