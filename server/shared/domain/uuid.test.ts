/**
 * Regression tests for uuidv7.
 *
 * Master prompt rule 1: invariants that protect correctness need
 * tests. The Zod `z.string().uuid()` regex requires the 17th hex
 * nibble (the variant) to be in `[89ab]`. A previous version of
 * uuidv7() set the variant nibble at the wrong position, producing
 * strings that pass the obvious "looks like a UUID" check but fail
 * strict UUID validation (the variant nibble was a random digit,
 * not `a`/`b`). These tests pin the RFC 9562 / UUIDv7 invariants.
 *
 * Run: `pnpm test:unit`
 */
import { describe, expect, it } from 'vitest';
import { uuidv4, uuidv7 } from './uuid.js';

const RFC9562_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

describe('uuidv7', () => {
  it('produces a string that matches the RFC 9562 UUIDv7 grammar', () => {
    for (let i = 0; i < 50; i++) {
      const u = uuidv7();
      expect(u, `UUIDv7 ${u} failed the strict UUID regex`).toMatch(RFC9562_REGEX);
    }
  });

  it('sets version=7 in the 13th hex digit', () => {
    const u = uuidv7();
    expect(u.charAt(14)).toBe('7');
  });

  it('sets variant=10 (a..b) in the 17th hex digit', () => {
    for (let i = 0; i < 50; i++) {
      const u = uuidv7();
      const variant = u.charAt(19).toLowerCase();
      expect(['8', '9', 'a', 'b']).toContain(variant);
    }
  });

  it('is time-ordered (sorts the same as creation order)', () => {
    // Two UUIDv7 values generated with later epochs must sort after
    // those generated with earlier epochs. Note that uuidv7 uses 48
    // bits of timestamp + 80 bits of random, so two calls within
    // the same millisecond may not sort deterministically. We
    // explicitly pass distinct epochs.
    const early = uuidv7(1_700_000_000_000);
    const late = uuidv7(1_700_000_000_001);
    expect(early < late).toBe(true);
  });

  it('accepts a custom epoch ms', () => {
    const u = uuidv7(0);
    expect(u.startsWith('00000000-0000-7')).toBe(true);
  });

  it('uuidv4 still returns a v4 (smoke)', () => {
    const u = uuidv4();
    expect(u).toMatch(RFC9562_REGEX);
    expect(u.charAt(14)).toBe('4');
  });
});
