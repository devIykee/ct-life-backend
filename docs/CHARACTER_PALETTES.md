# Authored character palettes

`GET /v1/config` now includes `characterPalettes` beside `items`, `traits` and the
other config fields. This is a live server capability, not a paid shop catalog.
Its `version` is 1 and `models` contains `head_ubc_m` (Dex) and `head_ubc_f` (Nova).
Each model declares exact `skinTones`, `hairIds`, `topIds`, `bottomIds`, `shoesIds`
and `accIds`. The unchanged head identity completes the existing seven-field look.

The clothing regions and hair colours mix independently on the same authored mesh.
No body-part geometry or outfit is replaced by a colour suffix. Every field is
checked against its own head's allowlist; cross-head IDs, unknown colours, multiple
suffixes, extra properties and accessory additions fail with `VALIDATION_FAILED`.
Other legacy authored looks retain their existing catalog checks.

The source of server acceptance and capability output is
`server/shared/domain/character-palettes.ts`; it matches the artist-authored client
`Assets/Art/characters/palettes/manifest.json` palette identifiers. Per head:

- Skin: unchanged `skin_tone3`, or `skin_01` through `skin_10`.
- Hair: baseline plus 12 colours.
- Top, bottom, shoes: their respective baseline plus 16 colours each.
- Accessory: `acc_none` only.

The client must require a fresh successful network validation of the capability
before offering a palette submission. The presence of a cached config alone is not
proof that the connected backend accepts it. The server still validates the request
independently. Config's ETag incorporates the capability payload.

Validation: 52 palette tests pass, including real isolated-Postgres character
creation/persistence for all 32 existing authored submissions (10 identities and
22 wardrobe variations), finite colour capability output, mixed-body rejection and
extra-field rejection. The combined likeness/operator/palette/auth-signature
regression run passes 247 tests across 12 files. Local API port 4010 was restarted after confirming
`APP_ENV=local` and a localhost database. Live config returns both registries with
11/13/17/17/17/1 choices. No staging/production service was restarted.
