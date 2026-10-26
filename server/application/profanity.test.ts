import { describe, expect, it } from 'vitest';
import { containsProfanity, maskProfanity, isBlockedText } from './factory-filter.js';

describe('free-text profanity filter', () => {
  it('catches slurs and swearing incl. leetspeak, repeats and spaced letters', () => {
    for (const t of [
      'fuck you',
      'you are a sh1t',
      'FUUUCK',
      'f.u.c.k',
      'f u c k',
      'what an a s s hole',
      'kys',
    ]) {
      expect(containsProfanity(t), t).toBe(true);
    }
  });

  it('does not trip on words that merely contain letters across a word boundary', () => {
    for (const t of [
      'this hit the spot',
      'who removed it',
      'which ink pen',
      'pass it on',
      'hello world',
      'gm gm',
      'send 5 sol to my wallet',
    ]) {
      expect(containsProfanity(t), t).toBe(false);
    }
  });

  it('masks words, hides evasions it cannot mask', () => {
    expect(maskProfanity('hello fuck world')).toBe('hello **** world');
    expect(maskProfanity('all good')).toBe('all good');
    expect(maskProfanity('f u c k')).toBe('[message hidden]');
  });

  it('coin-name filter keeps its stricter whole-text behaviour', () => {
    expect(isBlockedText('this hit')).toBe(true);
    expect(isBlockedText('Moon Cat')).toBe(false);
  });
});
