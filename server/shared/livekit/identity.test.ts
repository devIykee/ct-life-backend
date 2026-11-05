import { describe, expect, it } from 'vitest';
import { mediaIdentity, mediaPlayerId, parseMediaIdentity } from './identity.js';

const userId = '019a5750-0000-7000-8000-000000000001';
const identityId = '019a5750-0000-7000-8000-000000000002';

describe('media credential identity', () => {
  it.each([0, 9, 10, 2147483647])('round trips canonical generation %i', (version) => {
    const scope = { userId, identityId, version };
    const value = mediaIdentity(scope);
    expect(parseMediaIdentity(value)).toEqual(scope);
    expect(mediaPlayerId(value)).toBe(userId);
  });

  it('preserves player lookups across independent credentials and generations', () => {
    const first = mediaIdentity({ userId, identityId, version: 0 });
    const next = mediaIdentity({ userId, identityId, version: 1 });
    const retained = mediaIdentity({
      userId,
      identityId: '019a5750-0000-7000-8000-000000000003',
      version: 0,
    });
    expect(new Set([first, next, retained]).size).toBe(3);
    expect([first, next, retained].map(mediaPlayerId)).toEqual([userId, userId, userId]);
  });

  it('recognises a legacy player UUID without granting it credential authority', () => {
    expect(mediaPlayerId(userId)).toBe(userId);
    expect(parseMediaIdentity(userId)).toBeNull();
  });

  it.each(['', '-1', '+1', '00', '01', '1.0', '1e1', ' 1', '1 ', '2147483648', '9007199254740993'])(
    'rejects malformed generation %j',
    (version) => {
      const value = `ct1:${userId}:${identityId}:${version}`;
      expect(parseMediaIdentity(value)).toBeNull();
      expect(mediaPlayerId(value)).toBeNull();
    },
  );

  it.each([
    `ct2:${userId}:${identityId}:0`,
    `ct1:${userId.toUpperCase()}:${identityId}:0`,
    `ct1:${userId}:00000000-0000-0000-0000-000000000000:0`,
    `ct1:${userId}:${identityId}:0:extra`,
    `ct1:${userId.replace(/-/g, '')}:${identityId}:0`,
    '00000000-0000-0000-0000-000000000000',
    userId.toUpperCase(),
  ])('does not reinterpret malformed qualified identities as players: %s', (value) => {
    expect(parseMediaIdentity(value)).toBeNull();
    expect(mediaPlayerId(value)).toBeNull();
  });

  it.each([-1, 1.5, NaN, Infinity, 2147483648])(
    'refuses to mint invalid generation %s',
    (version) => {
      expect(() => mediaIdentity({ userId, identityId, version })).toThrow(
        'Invalid media credential scope',
      );
    },
  );
});
