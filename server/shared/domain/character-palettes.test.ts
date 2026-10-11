import { describe, expect, it } from 'vitest';
import {
  CHARACTER_PALETTES,
  validateCharacterPalette,
  type CharacterLook,
} from './character-palettes.js';
import { ValidationFailedError } from './errors.js';
import {
  HUMAN_PALETTE_SOURCES,
  FITTED_HAIR_LOOKS,
  recoloured,
} from './character-palette-fixtures.js';

const look: CharacterLook = {
  skinTone: 'skin_10',
  headId: 'head_ubc_m',
  hairId: 'hair_ubc_m__auburn',
  topId: 'top_ubc_m__sol_purple',
  bottomId: 'bottom_ubc_m__khaki',
  shoesId: 'shoes_ubc_m__teal',
  accId: 'acc_none',
};
describe('authored body palette validation', () => {
  it.each(['ubc_m', 'ubc_f'])('accepts independent colours and baseline for %s', (body) => {
    const changed = Object.fromEntries(
      Object.entries(look).map(([key, value]) => [key, value.replaceAll('ubc_m', body)]),
    ) as unknown as CharacterLook;
    expect(() => validateCharacterPalette(changed)).not.toThrow();
    expect(() =>
      validateCharacterPalette({
        skinTone: 'skin_tone3',
        headId: `head_${body}`,
        hairId: `hair_${body}`,
        topId: `top_${body}`,
        bottomId: `bottom_${body}`,
        shoesId: `shoes_${body}`,
        accId: 'acc_none',
      }),
    ).not.toThrow();
  });
  it.each([
    { hairId: 'hair_ubc_f__auburn' },
    { topId: 'top_ubc_m__blue' },
    { bottomId: 'bottom_ubc_m__black__red' },
    { shoesId: 'shoes_ubc_m__' },
    { hairId: 'hair_ubc_m__sol_green' },
    { skinTone: 'skin_11' },
    { skinTone: 'skin_1' },
    { accId: 'acc_hat' },
    { headId: 'head_snow' },
    { headId: 'head_ubc_x' },
    { topId: 'top_ubc_m__RED' },
  ])('rejects an invalid or mixed identity: %j', (change) => {
    expect(() => validateCharacterPalette({ ...look, ...change })).toThrow(ValidationFailedError);
  });
  it('rejects extra look fields instead of discarding them', () => {
    expect(() => validateCharacterPalette({ ...look, accent: 'gold' } as CharacterLook)).toThrow(
      ValidationFailedError,
    );
  });
  it('keeps unrelated existing seven-field looks compatible', () => {
    expect(() =>
      validateCharacterPalette({
        skinTone: 'skin_tone3',
        headId: 'head_hero_assassin',
        hairId: 'hair_hero_assassin',
        topId: 'top_hero_assassin',
        bottomId: 'bottom_hero_assassin',
        shoesId: 'shoes_hero_assassin',
        accId: 'acc_none',
      }),
    ).not.toThrow();
  });
  it.each(HUMAN_PALETTE_SOURCES)(
    'accepts exact source and independent recolours for $headId',
    (source) => {
      expect(() => validateCharacterPalette(source)).not.toThrow();
      expect(() => validateCharacterPalette(recoloured(source))).not.toThrow();
    },
  );
  it.each(FITTED_HAIR_LOOKS)('accepts actually imported fitted hairstyle $hairId', (source) => {
    expect(() => validateCharacterPalette(source)).not.toThrow();
  });
  it.each([
    { hairId: 'hair_ubc_m_parted__pink' },
    { hairId: 'hair_ubc_f_long__pink' },
    { hairId: 'hair_ubc_m_buzzed__black__red' },
    { headId: 'head_unimported', hairId: 'hair_ubc_m_long__pink' },
  ])('rejects unimported or mixed hairstyle: %j', (change) => {
    expect(() => validateCharacterPalette({ ...look, ...change })).toThrow(ValidationFailedError);
  });
  it('retains one person identity across each of twelve Snow/Rain outfits', () => {
    expect(CHARACTER_PALETTES.models).toHaveLength(26);
    expect(CHARACTER_PALETTES.models.filter((m) => m.personId === 'head_snow')).toHaveLength(12);
    expect(CHARACTER_PALETTES.models.filter((m) => m.personId === 'head_rain')).toHaveLength(12);
    for (const source of HUMAN_PALETTE_SOURCES) {
      expect(() => validateCharacterPalette({ ...source, hairId: 'hair_ubc_m_buzzed' })).toThrow(
        ValidationFailedError,
      );
      expect(() =>
        validateCharacterPalette({ ...source, topId: source.topId + '__unlisted' }),
      ).toThrow(ValidationFailedError);
      expect(() =>
        validateCharacterPalette({
          ...source,
          shoesId: 'shoes_player_f_coat__teal',
          headId: 'head_snow',
        }),
      ).toThrow(ValidationFailedError);
    }
  });
});
