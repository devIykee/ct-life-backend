# Proposed Snow starter look — UNAPPROVED

This is a frontend presentation proposal, not an imported/backend contract change. The current contract does not contain this complete look. No backend files were changed. The creator may preview the authored character, but submission remains unavailable until a live config response explicitly supplies all six non-skin item IDs with the expected slots and free/starter status.

The existing `Look.skinTone` field is a plain string. It does not need an invented `skin` item registry entry. Proposed request look:

```json
{
  "skinTone": "skin_tone3",
  "headId": "head_snow",
  "hairId": "hair_snow_bun",
  "topId": "top_vneck_charcoal",
  "bottomId": "bottom_denim_light",
  "shoesId": "shoes_sneakers_blue",
  "accId": "acc_none"
}
```

Literal proposed additive fields in a successful `GET /v1/config` payload:

```json
{
  "items": {
    "items": [
      { "id": "head_snow", "slot": "head", "cashCents": 0, "phase": 1 },
      { "id": "hair_snow_bun", "slot": "hair", "cashCents": 0, "phase": 1 },
      { "id": "top_vneck_charcoal", "slot": "top", "cashCents": 0, "phase": 1 },
      { "id": "bottom_denim_light", "slot": "bottom", "cashCents": 0, "phase": 1 },
      { "id": "shoes_sneakers_blue", "slot": "shoes", "cashCents": 0, "phase": 1 },
      { "id": "acc_none", "slot": "acc", "cashCents": 0, "phase": 1 }
    ]
  }
}
```

This fragment accompanies the server's normal config fields and existing items; it is not a replacement response. The frontend also accepts `items: { "head_snow": { "slot": "head", "cashCents": 0 }, ... }`, or the wrapped `ids.items` registry. A boolean `starter` field, if explicitly present, takes precedence over the existing `cashCents: 0` free-item convention. Missing price and missing starter status do not imply permission.

The first config request in each app process is unconditional. Only a successful raw network response sets `ConfigStore.HasNetworkValidation`; disk cache and merged bundled fallbacks cannot confirm a proposed item. Later conditional requests may return 304 while keeping that session's confirmed IDs. A newer full response rebuilds confirmation from its own raw item registry, so removed or missing IDs become unavailable again.

Validation handoff: verify raw array/map forms; cold cache + first 200 + later304; cached-only data; missing/paid/mis-slotted IDs; explicit starter:false; and that today's contract still rejects the proposed Snow look. Unity compilation/network integration are coordinator-owned and were not run for this patch by the audit agent.
