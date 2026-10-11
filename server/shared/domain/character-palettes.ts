/** Finite capabilities for authored human bodies/outfits. Hairstyles are fitted geometry; colours are independent. */
import { ValidationFailedError } from './errors.js';

const HAIR_COLOURS = [
  'black',
  'dark_brown',
  'brown',
  'auburn',
  'ginger',
  'blonde',
  'platinum',
  'grey',
  'pink',
  'blue',
  'green',
  'purple',
] as const;
const CLOTHING_COLOURS = [
  'black',
  'charcoal',
  'white',
  'navy',
  'denim',
  'khaki',
  'olive',
  'red',
  'orange',
  'gold',
  'green',
  'teal',
  'purple',
  'pink',
  'sol_purple',
  'sol_green',
] as const;
const variants = (base: string, colours: readonly string[]) => [
  base,
  ...colours.map((colour) => `${base}__${colour}`),
];

// Exact FE sourceLook values from Art/characters/palettes/humans/manifest.json (2026-10-11).
// These 24 outfit keys represent Snow and Rain, not 24 people. Keep original source skins/accessories.
const HUMAN_SOURCE_LOOKS = [
  [
    'skin_tone3',
    'head_snow',
    'hair_snow_bun',
    'top_vneck_charcoal',
    'bottom_denim_light',
    'shoes_sneakers_blue',
    'acc_none',
  ],
  [
    'skin_brown',
    'head_player_m_trencher',
    'hair_player_m_trencher',
    'top_player_m_trencher',
    'bottom_player_m_trencher',
    'shoes_player_m_trencher',
    'acc_none',
  ],
  [
    'skin_tan',
    'head_player_m_perp',
    'hair_player_m_perp',
    'top_player_m_perp',
    'bottom_player_m_perp',
    'shoes_player_m_perp',
    'acc_none',
  ],
  [
    'skin_olive',
    'head_player_m_shark',
    'hair_player_m_shark',
    'top_player_m_shark',
    'bottom_player_m_shark',
    'shoes_player_m_shark',
    'acc_none',
  ],
  [
    'skin_fair',
    'head_player_m_farmer',
    'hair_player_m_farmer',
    'top_player_m_farmer',
    'bottom_player_m_farmer',
    'shoes_player_m_farmer',
    'acc_none',
  ],
  [
    'skin_dark',
    'head_player_m_kol',
    'hair_player_m_kol',
    'top_player_m_kol',
    'bottom_player_m_kol',
    'shoes_player_m_kol',
    'acc_none',
  ],
  [
    'skin_deep',
    'head_player_m_builder',
    'hair_player_m_builder',
    'top_player_m_builder',
    'bottom_player_m_builder',
    'shoes_player_m_builder',
    'acc_none',
  ],
  [
    'skin_light',
    'head_player_m_anon',
    'hair_player_m_anon',
    'top_player_m_anon',
    'bottom_player_m_anon',
    'shoes_player_m_anon',
    'acc_none',
  ],
  [
    'skin_deep',
    'head_player_m_lagos_kaftan',
    'hair_player_m_lagos_kaftan',
    'top_player_m_lagos_kaftan',
    'bottom_player_m_lagos_kaftan',
    'shoes_player_m_lagos_kaftan',
    'acc_none',
  ],
  [
    'skin_light',
    'head_player_m_tradfi',
    'hair_player_m_tradfi',
    'top_player_m_tradfi',
    'bottom_player_m_tradfi',
    'shoes_player_m_tradfi',
    'acc_none',
  ],
  [
    'skin_olive',
    'head_player_m_coat',
    'hair_player_m_coat',
    'top_player_m_coat',
    'bottom_player_m_coat',
    'shoes_player_m_coat',
    'acc_none',
  ],
  [
    'skin_dark',
    'head_player_m_skr',
    'hair_player_m_skr',
    'top_player_m_skr',
    'bottom_player_m_skr',
    'shoes_player_m_skr',
    'acc_none',
  ],
  [
    'skin_tone3',
    'head_rain',
    'hair_rain_ponytail',
    'top_sleeveless_white',
    'bottom_denim_fitted',
    'shoes_canvas_ochre',
    'acc_scarf_sky',
  ],
  [
    'skin_warm',
    'head_player_f_trencher',
    'hair_player_f_trencher',
    'top_player_f_trencher',
    'bottom_player_f_trencher',
    'shoes_player_f_trencher',
    'acc_none',
  ],
  [
    'skin_deep',
    'head_player_f_lagos_ankara',
    'hair_player_f_lagos_ankara',
    'top_player_f_lagos_ankara',
    'bottom_player_f_lagos_ankara',
    'shoes_player_f_lagos_ankara',
    'acc_none',
  ],
  [
    'skin_light',
    'head_player_f_blazer',
    'hair_player_f_blazer',
    'top_player_f_blazer',
    'bottom_player_f_blazer',
    'shoes_player_f_blazer',
    'acc_none',
  ],
  [
    'skin_tan',
    'head_player_f_kol',
    'hair_player_f_kol',
    'top_player_f_kol',
    'bottom_player_f_kol',
    'shoes_player_f_kol',
    'acc_none',
  ],
  [
    'skin_brown',
    'head_player_f_builder',
    'hair_player_f_builder',
    'top_player_f_builder',
    'bottom_player_f_builder',
    'shoes_player_f_builder',
    'acc_none',
  ],
  [
    'skin_olive',
    'head_player_f_anon',
    'hair_player_f_anon',
    'top_player_f_anon',
    'bottom_player_f_anon',
    'shoes_player_f_anon',
    'acc_none',
  ],
  [
    'skin_dark',
    'head_player_f_perp',
    'hair_player_f_perp',
    'top_player_f_perp',
    'bottom_player_f_perp',
    'shoes_player_f_perp',
    'acc_none',
  ],
  [
    'skin_fair',
    'head_player_f_farmer',
    'hair_player_f_farmer',
    'top_player_f_farmer',
    'bottom_player_f_farmer',
    'shoes_player_f_farmer',
    'acc_none',
  ],
  [
    'skin_tan',
    'head_player_f_shark',
    'hair_player_f_shark',
    'top_player_f_shark',
    'bottom_player_f_shark',
    'shoes_player_f_shark',
    'acc_none',
  ],
  [
    'skin_olive',
    'head_player_f_coat',
    'hair_player_f_coat',
    'top_player_f_coat',
    'bottom_player_f_coat',
    'shoes_player_f_coat',
    'acc_none',
  ],
  [
    'skin_brown',
    'head_player_f_lagos_kaftan',
    'hair_player_f_lagos_kaftan',
    'top_player_f_lagos_kaftan',
    'bottom_player_f_lagos_kaftan',
    'shoes_player_f_lagos_kaftan',
    'acc_none',
  ],
] as const;
const SKIN_COLOURS = Array.from({ length: 10 }, (_, i) => `skin_${String(i + 1).padStart(2, '0')}`);
function palette(look: readonly string[], personId: string, hairStyles: readonly string[] = []) {
  const [skinTone, headId, hairId, topId, bottomId, shoesId, accId] = look as readonly [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  return {
    headId,
    personId,
    skinTones: [skinTone, ...SKIN_COLOURS],
    hairIds: [hairId, ...hairStyles].flatMap((id) => variants(id, HAIR_COLOURS)),
    topIds: variants(topId, CLOTHING_COLOURS),
    bottomIds: variants(bottomId, CLOTHING_COLOURS),
    shoesIds: variants(shoesId, CLOTHING_COLOURS),
    accIds: [accId],
  };
}
export const CHARACTER_PALETTES = {
  version: 1,
  models: [
    ...(['ubc_m', 'ubc_f'] as const).map((body) =>
      palette(
        [
          'skin_tone3',
          `head_${body}`,
          `hair_${body}`,
          `top_${body}`,
          `bottom_${body}`,
          `shoes_${body}`,
          'acc_none',
        ],
        `head_${body}`,
        (body === 'ubc_m' ? ['buzzed', 'long', 'buns'] : ['buns', 'buzzed', 'parted']).map(
          (style) => `hair_${body}_${style}`,
        ),
      ),
    ),
    ...HUMAN_SOURCE_LOOKS.map((look) =>
      palette(
        look,
        look[1] === 'head_snow' || look[1].startsWith('head_player_m_') ? 'head_snow' : 'head_rain',
      ),
    ),
  ],
};

export interface CharacterLook {
  readonly skinTone: string;
  readonly headId: string;
  readonly hairId: string;
  readonly topId: string;
  readonly bottomId: string;
  readonly shoesId: string;
  readonly accId: string;
}
const LOOK_KEYS = ['skinTone', 'headId', 'hairId', 'topId', 'bottomId', 'shoesId', 'accId'];

const PALETTE_ITEMS = new Set(
  CHARACTER_PALETTES.models.flatMap((model) => [
    ...model.hairIds,
    ...model.topIds,
    ...model.bottomIds,
    ...model.shoesIds,
  ]),
);
/** Reject undeclared fields and mixed/malformed palette identities; retain unrelated legacy authored looks. */
export function validateCharacterPalette(look: CharacterLook): void {
  if (
    Object.keys(look).length !== LOOK_KEYS.length ||
    Object.keys(look).some((key) => !LOOK_KEYS.includes(key))
  )
    throw new ValidationFailedError({ reason: 'look_requires_exactly_seven_fields' });
  const model = CHARACTER_PALETTES.models.find((entry) => entry.headId === look.headId);
  if (!model) {
    if (
      Object.values(look).some(
        (id) =>
          typeof id === 'string' &&
          (PALETTE_ITEMS.has(id) ||
            id.includes('__') ||
            /^skin_\d+$/.test(id) ||
            /_ubc_[mf](?:_|$)/.test(id)),
      )
    )
      throw new ValidationFailedError({ reason: 'palette_identity_mismatch' });
    return; // Other legacy authored looks keep their existing catalog validation.
  }
  const slots = {
    skinTone: model.skinTones,
    hairId: model.hairIds,
    topId: model.topIds,
    bottomId: model.bottomIds,
    shoesId: model.shoesIds,
    accId: model.accIds,
  };
  for (const [slot, allowed] of Object.entries(slots)) {
    const value = look[slot as keyof typeof slots];
    if (!allowed.includes(value))
      throw new ValidationFailedError({
        reason: 'invalid_character_palette',
        headId: look.headId,
        slot,
        itemId: value,
      });
  }
}
