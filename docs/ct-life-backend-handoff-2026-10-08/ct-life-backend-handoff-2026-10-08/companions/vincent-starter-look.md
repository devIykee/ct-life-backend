# Proposed Vincent / Weekender starter look — UNAPPROVED

2026-10-06. Frontend presentation proposal for devIykee. Source adaptation is in progress; native import and device acceptance are pending. This does not change the imported contract, backend or bundled config.

- A complete adult male look: swept hair, glasses, mustard shirt, slate trousers and white slip-on shoes.
- Creator label: `creator.look.weekender` → Weekender.
- Exact proposed seven-value registry key:

```text
skin_tone1|head_vincent|hair_vincent_swept|top_shirt_mustard|bottom_trousers_slate|shoes_slipon_white|acc_glasses_charcoal
```

Proposed `Look` request:

```json
{
  "skinTone": "skin_tone1",
  "headId": "head_vincent",
  "hairId": "hair_vincent_swept",
  "topId": "top_shirt_mustard",
  "bottomId": "bottom_trousers_slate",
  "shoesId": "shoes_slipon_white",
  "accId": "acc_glasses_charcoal"
}
```

Proposed additive entries in a successful `GET /v1/config` response (retain all existing fields/items):

```json
{
  "items": {
    "items": [
      { "id": "head_vincent", "slot": "head", "cashCents": 0, "phase": 1 },
      { "id": "hair_vincent_swept", "slot": "hair", "cashCents": 0, "phase": 1 },
      { "id": "top_shirt_mustard", "slot": "top", "cashCents": 0, "phase": 1 },
      { "id": "bottom_trousers_slate", "slot": "bottom", "cashCents": 0, "phase": 1 },
      { "id": "shoes_slipon_white", "slot": "shoes", "cashCents": 0, "phase": 1 },
      { "id": "acc_glasses_charcoal", "slot": "acc", "cashCents": 0, "phase": 1 }
    ]
  }
}
```

- `skinTone` remains the contract's plain string; no new skin item slot.
- Only the complete tuple has authored geometry. This does not enable arbitrary cross-character clothes, head swaps or skin recolors.
- `ConfigStore.IsLookConfirmed` must require all six correctly slotted starter/free IDs from a successful raw network response in the current process. Cached registries, art installation and this proposal do not permit submission. Explicit `starter:false`, a paid/missing/mis-slotted item or later removal must reject it.
- Do not mutate player ownership or call character creation for NPC art reuse. A separate frontend NPC cast catalog may reference a whole presentation entry without changing the NPC wire schema.
- Native target paths: `authored/Vincent/Weekender.prefab` and `WeekenderWorld.prefab`. They remain planned until the import passes.
- Backend integration checks follow the [Rain look proposal](rain-starter-look.md): raw array/map registries; cold cache → 200 → 304; cached-only rejection; removed/paid/mis-slotted IDs; exact-tuple submission; remote avatar resolution.

Source: [Vincent v1](https://studio.blender.org/characters/vincent/v1/), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Credit: Vincent (CC) Blender Foundation | studio.blender.org. The source download and adaptation evidence are under `art/character-candidates/male-source-audit/` and `vincent-adult-production/`.
