/**
 * The `beef` block of GET /config: null while the capability is off, and the client
 * fields read from beef_topics.json while it is on. Eligibility itself is covered over
 * HTTP in server/api/beef-routes.test.ts (it reads the database).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AppContext } from './context.js';
import { beefClientConfig } from './beef-eligibility.js';
import type { BeefConfig } from './beef-rules.js';

const file = JSON.parse(
  readFileSync(new URL('../../contract/config/beef_topics.json', import.meta.url), 'utf8'),
) as BeefConfig;

function ctx(on: string[]): AppContext {
  return {
    config: { capabilities: { on: new Set(on) } },
    configCache: { load: () => file },
  } as unknown as AppContext;
}

describe('beefClientConfig', () => {
  it('is null while beef is off', () => {
    expect(beefClientConfig(ctx([]))).toBeNull();
    expect(beefClientConfig(ctx(['beefVoting']))).toBeNull();
  });

  it('serves the topics, reward, daily cap and both gates while on', () => {
    const c = beefClientConfig(ctx(['beef']))!;
    expect(c.version).toBe(file.version);
    expect(c.topics).toEqual(file.topics.map((t) => ({ id: t.id, label: t.label })));
    expect(c.winnerRewardCents).toBe(file.reward.winnerCents);
    expect(c.maxRewardedWinsPerDay).toBe(file.reward.maxRewardedWinsPerDay);
    expect(c.minAccountAgeHours).toBe(file.participants.minAccountAgeHours);
    expect(c.minShiftDays).toBe(file.participants.minShiftDays);
    expect(c.voters).toEqual(file.voters);
  });
});
