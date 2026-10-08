# Proposed Rain / Breeze starter look — UNAPPROVED

2026-10-06. This is a frontend presentation proposal for devIykee, not an imported/backend contract change. Rain's native Unity import passed and device build L is in progress. The current `contract/ids/items.json` has none of the six proposed non-skin IDs below. No backend, imported contract, or bundled config snapshot was changed.

The creator has one complete authored Breeze look with its own face/body, ponytail, scarf, top, jeans and shoes. This is not an interchangeable wardrobe. Its registry key is the exact ordered seven-value tuple:

```text
skin_tone3|head_rain|hair_rain_ponytail|top_sleeveless_white|bottom_denim_fitted|shoes_canvas_ochre|acc_scarf_sky
```

Proposed request `Look`:

```json
{
  "skinTone": "skin_tone3",
  "headId": "head_rain",
  "hairId": "hair_rain_ponytail",
  "topId": "top_sleeveless_white",
  "bottomId": "bottom_denim_fitted",
  "shoesId": "shoes_canvas_ochre",
  "accId": "acc_scarf_sky"
}
```

`skinTone` is the contract's plain string field; this proposal does not invent a skin item registry slot. Literal proposed additive entries in the normal successful `GET /v1/config` response:

```json
{
  "items": {
    "items": [
      { "id": "head_rain", "slot": "head", "cashCents": 0, "phase": 1 },
      { "id": "hair_rain_ponytail", "slot": "hair", "cashCents": 0, "phase": 1 },
      { "id": "top_sleeveless_white", "slot": "top", "cashCents": 0, "phase": 1 },
      { "id": "bottom_denim_fitted", "slot": "bottom", "cashCents": 0, "phase": 1 },
      { "id": "shoes_canvas_ochre", "slot": "shoes", "cashCents": 0, "phase": 1 },
      { "id": "acc_scarf_sky", "slot": "acc", "cashCents": 0, "phase": 1 }
    ]
  }
}
```

This fragment accompanies existing response fields and items; it is not a replacement payload. The frontend also accepts an item-ID map or the wrapped `ids.items` registry. An explicit boolean `starter` overrides the `cashCents: 0` convention; missing price/status does not authorize use.

Current `ConfigStore.IsLookConfirmed` requires all six IDs with matching slots and free/starter status from a successful raw network response in the current app process. Disk cache, merged presentation fallbacks, imported art, and the proposal itself do not authorize submission. The first config request is unconditional; later304 responses preserve that process's prior network confirmation. A newer full response rebuilds confirmation from its own raw registry.

Only this complete tuple is installed in the frontend `CharacterRegistry`; individual item aliases and mixed Snow/Rain combinations have no authored mesh. BE should review acceptance of this exact whole look alongside the Snow proposal rather than advertise arbitrary cross-base garment combinations. No new bundling field or endpoint is claimed implemented.

Frontend binding: `Assets/Art/characters/authored/Rain/Breeze.prefab` for full creator preview, `BreezeWorld.prefab` for the city LODGroup. Localized title key: `creator.look.breeze`. Source attribution: Rain Rig (CC) Blender Foundation | studio.blender.org, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), [source](https://studio.blender.org/characters/rain/v3/). Backend IDs confer no claim that dynamic body/face or garment customization is implemented.

Validation handoff: exercise raw array/map forms; cold cache then200 then304; cached-only state; one missing, paid, or mis-slotted item; explicit `starter:false`; a full response that removes an ID; exact-tuple submission and remote avatar resolution. Today's imported contract must continue to reject the unapproved tuple. Runtime credit installation, real device animation/foot-contact and performance checks remain coordinating-agent work.
