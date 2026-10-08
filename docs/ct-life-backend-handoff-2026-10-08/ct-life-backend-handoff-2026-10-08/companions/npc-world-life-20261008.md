# FE proposal: NPC archetypes, line ids, NpcState semantics, event params (world-life lane, 2026-10-08)

Status: **proposal**. Everything here is BE-owned (`contract/ids/archetypes.json`, `contract/config/npc_lines.json`,
`contract/config/events.json`, `contract/realtime/*`) except the anim/sfx ids (FE-owned registries, listed at the end).
The client already handles both today's backend behaviour and the proposed one, so none of this blocks the client.
Evidence: backend `ct-life-backend` main @ `9f3e5ef` (`packages/npc-brain/src/index.ts`, `server/realtime/rooms/venue.ts`,
`server/realtime/rooms/city.ts`, `server/realtime/schemas.ts`), read-only.

## 1. Archetype registry (`contract/ids/archetypes.json`)

| Change | Why |
| --- | --- |
| Add `laser_eyes_maxi` (anywhere, phase 2) | Spec NPC table row "Laser-Eyes Maxi". Audio already has bank `laser_eyes_maxi`. |
| Add `chain_tribalist` (venue `ratio_arena`, phase 2, `maxPerInstance: 2`) | Spec row "Chain Tribalists (pair)". Audio bank `chain_tribalist`. Two npcIds give two pitches. |
| Remove the duplicate `spaces_host` entry (phase 2 "alt") | Same id twice. |
| `normie.venueId`: `market_room` → `terminal_cafe` (or list `homeVenueIds: [terminal_cafe, timeline_square, launchpad_tower]`) | `market_room` is not a venue in `venues.json`. Spec: normies arrive in waves at peaks wherever trading happens. |
| Brain ids `vc_npc`, `builder_npc` → registry ids `vc`, `doxxed_founder` | `npc-brain` creates archetypes that are not in the registry; the client maps them (`archetypeAliases`). |

FE line sets for all 21 archetypes without a backend set (19 contract ids + the 2 above), 32–33 lines each, in rc1
format: `docs/fe-contract-proposals/npc_lines.world-life-20261008.json` (also proposed additions to 6 existing sets,
grounded in `docs/research/ct-now-2026-10.md` and `ct-x-observations-2026-10-04.md`). Parody names only.

## 2. Line ids

The brain sends named ids (`crier_long_liquidation`, `giveaway_pitch`, `reply_gm`, `perp_max_long`, `rekt_stimmy`,
`wallet_turnaround`, `doom_bear`, `spaces_gm`, `ore_board`, `ore_motherlode`, `vc_dibs`, `vc_pitch`, `vc_idle`,
`builder_hiring`, `builder_ship`, 16 `crier_*`). `npc_lines.json` has unnamed arrays, so no id resolves.

Proposal (either works with the client today):
- **A (preferred):** keyed lines: `{"town_crier": [{"id": "crier_rug", "text": "JUST IN: {coin} rugged. …"}, …]}`. Several
  entries may share an id (variants); the client picks one deterministically per `npcId|lineId|startedAt`.
- **B:** keep arrays and send `lineId: "<archetype>.<index>"`.

Until then the client binds each brain id to lines by substring (`lineAliases` in
`client/Assets/Scripts/Features/WorldLife/Resources/WorldLife/npc_presentation.json`).

## 3. `NpcState` semantics (contract `realtime/states.ts`)

1. **`startedAt` = when the current state began**, not "last tick". `venue.ts tickNpcs` writes `Date.now()` to every
   NPC every second, so followers that key on it restart walks and one-shots each second (the client now ignores
   repeats inside a run).
2. **Keep `animId` and `lineId` for the whole state.** The brain's fall-through branch sends `animId: 'loco_idle'`,
   `lineId: ''` on later ticks of `act`/`react`/`goto`/`talk`. The client treats the first action anim / line as sticky.
3. **Fill `lineParams`.** Never set today, so no slot line can show live numbers (e.g. `crier_coin_moon` needs
   `{coin, x, minutes}`).
4. **Spot ids from `spots.json` only.** Brain sends `perp_terminal`, `cafe_terminal`, `venue_exit`, `builder_hq_1/2`,
   venue ids (`rekt_clinic`, `spaces_studio`, `ore_refinery`, `vc_row`) and `"x0,z0"` strings built from walkable
   rectangles. Client aliases: `spotAliases` in the same JSON (e.g. `perp_terminal → terminal_*`).
5. **Cross-venue moves.** "Perp Degen respawns in the Rekt Clinic" is implemented as `spotId: rekt_clinic` inside the
   Perp Pit room. Contract §5 says `leave` here, then a fresh spawn in the other venue. Proposal: on `leave` with a venue
   id as `spotId`, remove the NPC from this room's state and add it to the target venue's instance(s). The client
   presents the current behaviour as leave + hidden until the NPC is back on a local spot.
6. **Brain inputs.** `VenueCtx.moodBps` is hard-coded 0, `recentEvents` is empty and `notify()` is never called, so the
   Town Crier never shouts events, the Doomposter is permanently `leave`, and Perp Degen ignores real liquidations.
   `richestPlayers` sorts on `netWorthCents: 0`, so Reply Guy follows the first player who joined, not the richest.

## 4. City `event` params (`contract/config/events.json` / `messages.ts EventMessage`)

`params` is `record<string,string>` with no keys documented. The client reads (and formats) these; please confirm or
rename:

| eventId | keys the client uses |
| --- | --- |
| `evt_liquidation` | `alias`, `ticker`, `lossCents`, `leverage`, `perpId` |
| `evt_rug` | `ticker`, `peakMcapCents`, `alias` (dev) |
| `evt_coin_launch` | `ticker`, `coinId` |
| `evt_mood_change` | `moodBps` (signed int), `direction` (`up`/`down`) |
| `evt_exploit` | `target` (parody protocol name), `lossCents` |
| `evt_ore_motherlode` | `amountOre` — **unit undefined** (base units vs whole ORE); the client does not show a number until defined |

Also: `server/realtime/rooms/city.ts` never broadcasts `event` yet (M3 TODO) and `mood` is a synthetic
`sin(t)·200` bps, which never reaches the −200 bps Doomposter threshold.

## 5. Behaviour triggers the client can stage (needs BE ids)

| Spec loop | Proposed server signal | Client staging (data: `behaviours` in npc_presentation.json) |
| --- | --- | --- |
| Sybil Farmer splits into 10 clones every 10 min | `act` with `animId: act_sybil_split` (or `emoteId: emote_sybil_split`, or `lineId: sybil_split`) | 10 small cosmetic clones around him (client-only, ≤ 90 s) |
| Community Mod arrives and clears them | community_mod NPC enters `act`/`talk` in the farm (or `animId: act_ban_hammer`, `emoteId: emote_ban`, `lineId: mod_ban`) | clones poof |
| Sniper Bots swarm the launch board for 10 s | `evt_coin_launch` (already in the contract) | 6 cosmetic drones at `launchpad_tower.swarm_1..6` |
| Normie wave at coin peaks | spawn `normie` NPCs (server-side; hidden arc stays server-only) | tourist look + lines; nothing client-side invented |
| Chain Tribalists debate | two `chain_tribalist` NPCs alternating `talk` | they face each other on every line |

## 6. FE-owned registry additions (for the lead / audio lane)

- `ids/anims.json`: `act_sybil_split`, `emote_sybil_split`, `act_ban_hammer`, `emote_ban` (only if BE adopts §5 as
  proposed; otherwise put BE's chosen ids in `behaviours`).
- `ids/sfx.json`: `sfx_liquidation_siren` (positional loop at the Perp Pit), `sfx_sniper_swarm` (drone buzz),
  `sfx_exploit_alarm` (Audit Row alarm). Until they exist the client falls back to `sfx_liquidation` / `sfx_new_coin`.
- Brain emote `emote_moon` is not in `anims.json`; client aliases it to `emote_moon_jump`.
