# Careers: 42 mini-games, seeding and shift assignment

[Proposal] From the careers lane, 8 Oct 2026. This is a frontend proposal, not an accepted contract change. Nothing
here changes the imported `contract/` snapshot, and the client does not assume the server accepts any of it. The
registry file is `docs/fe-contract-proposals/ids/mini_games.json`. It is generated from the client catalog, so the two
cannot drift.

## 1. Registry: 42 mini-games, 3 per career

The build spec, Phase 4 item 29, asks for "All 14 careers and gigs: 42 mini-games". The proposal covers every career
in `contract/config/careers.json` with three games.

| Status in the proposal file | Count | Meaning |
| --- | ---: | --- |
| `in_registry` | 3 | Already in `contract/ids/mini_games.json`. Values unchanged: `discord_mod_ban` 10/45 s, `junior_analyst_earnings` 100/60 s, `kols_engagement` 50/50 s. |
| `referenced_by_careers_json` | 11 | `careers.json` levels already point at these ids, but the registry only has the `thirty_more_career_games` placeholder: `copywriter_rewrite`, `designer_canvas`, `auditor_report`, `yield_farm_apy`, `shill_post`, `doxx_thread`, `trend_call`, `kol_negotiate`, `devrel_ama`, `alpha_call`, `sleuth_thread`. |
| `proposed` | 28 | 6 from `phase1-nine-games-20261007.md` and 22 new career games. |

Every proposed entry uses `maxScore: 100` and `durationSec` between 40 and 55. The shape is the contract's
`{id, careerId, maxScore, durationSec, phase}`. Keys that start with `_` (status, engine, title, real task) are review
notes and can be dropped on import.

**Today's backend behaviour (ct-life-backend 9f3e5ef, read-only).** For an id missing from the registry, the server
caps the score at 100 (`server/application/shifts.ts`). All proposed games score out of 100, so the cap already
matches. The 11 `careers.json` ids are still missing from the registry, so the contract's "capped at `maxScore` from
`mini_games.json`" rule has nothing to cap them against.

## 2. Assign more than one game per level (`miniGameIds`)

The spec says `careers.json` holds `miniGameIds` (plural). rc1 has a single `miniGameId` per level, and the backend
assigns only `levels[0].miniGameId`. So two of every career's three games can never be played for pay.

Proposal: each level carries `miniGameIds: [...]`, and `POST /shifts` returns 1–2 of them, rotating so a player
doesn't see the same game every shift. The client already reads `miniGameIds` (and falls back to `miniGameId`) and plays
whatever the server assigns, in order.

## 3. Deterministic seeds and replayable rounds

Every round in the client is built only from a 32-bit seed plus the registry cap and duration. Same inputs give the same
deck, boards, curves and drift, and the EditMode tests check this for all 33 new games. The seed of a paid round is:

- `seed = FNV-1a-32(UTF-8("ctlife.mg.v1|" + shiftId + "|" + miniGameId + "|" + index))`, read as int32.
- PRNG: Mulberry32. Reference vectors are in `Tests/FrameworkTests.cs`: seed 1 gives 2693262067, 11749833, …;
  `ForShift("shift_1", "discord_mod_ban", 0)` = 74929860.

Proposals, in order of effort:

1. **Now:** nothing. The client derives the seed from `shiftId`.
2. **Optional:** `Shift` gains `seed` (int32). The client uses it when present. This lets the server rotate content
   without a client release.
3. **Anti-cheat, later:** today any client can post `maxScore` (QA code-architecture §2.7). Because rounds are
   reproducible from the seed, `results[]` could carry an input log, e.g. `{t, action}` pairs. The server could
   replay it with a TypeScript port of the round rules. The board games (sort, flag, match, sequence, pick, combo)
   are pure functions of seed + inputs. The timing and balance games use a fixed 20 Hz step, so they replay exactly
   too. `[Inference]` Porting 8 small engines is days of work, not weeks. This would be a contract major change; it
   is not requested now.

## 4. GET /careers: two ambiguities

- **`active`.** The contract says `Career[]` "with my level and XP" plus `active`. The backend returns every offered
  career with `active: true` (it filters on the config flag). The client therefore treats `active` as "held job" only
  when at most one row is active. Otherwise it remembers the last confirmed `POST /apply` per user. Please pick one
  meaning. Proposal: `active` = this is my current job, plus `offered` for the config flag.
- **Promotion progress.** The client shows level, XP and the next level's pay, but cannot show progress to
  promotion. Nothing in the contract defines the threshold, and `skills.json xpPerShiftLevel` is ambiguous.
  Proposal: add `xpToNext` (null at level 5) to each `GET /careers` row. The client never computes promotions; it
  shows `promoted` from the shift receipt.

## 5. Gigs: contract vs backend

| | Contract | Backend checkout |
| --- | --- | --- |
| Ids | `doot_feed`, `drop_alpha`, `write_thread`, `audit_token` (`config/gigs.json`, CT-native) | `food_delivery`, `data_entry`, `dog_walking`, `ad_clicks`, `social_moderation` (`server/application/gigs.ts`) |
| `GET /gigs` | `Gig[] {id, name, durationSec, payCents, cooldownSec}` | `{gigs: [{gigId, name, description, minPayCents, maxPayCents}]}` |
| `POST /gigs/{id}/run` | no body → 200 `{payCents, outcomeId}`; 429 `RATE_LIMITED` with `retryAfterMs` | 201; reads optional client inputs (`distanceKm`, `clicks`, …) that set the pay; no cooldown |

The client reads both shapes. It shows CT flavour for both id sets. It never sends pay inputs: the contract has no
body, and client-reported inputs would let a client pick its own pay. Proposal: serve the contract's `gigs.json` ids
and formulas, enforce `cooldownSec`, and compute pay from the player's skills on the server.

## 6. Other backend observations for the feedback log

- `POST /careers/{id}/apply` returns `{id, level}` (feedback item 49). The client accepts both shapes.
- Skill gates never block. `getUserSkill` returns 10. The rc1 gate shape is `{"skill": "coding", "level": 1}`, but
  the backend iterates it as a `{skill: level}` map, so it compares 10 with "coding" and with 1, and nothing ever blocks. The client
  shows gates from config and treats a `VALIDATION_FAILED reason: skill_gate` as the authority.
- `GET /careers` always returns `level: 1, xp: 0`. Shift XP is returned but not persisted, and `promoted` is always
  false.
- `POST /shifts/{id}/complete` accepts any `miniGameId`, including ones that weren't assigned. Each extra result adds
  to the pay ratio. Confirmed live on 8 Oct with a throwaway dev wallet: a 0/10 `discord_mod_ban` plus an invented
  `made_up_game: 100` paid 3636 cents instead of 0.
- A second completion with a new key returns `404 NOT_FOUND {kind: shift_completed}`. Proposal: return `409` with the
  original receipt, so a client that lost the first response can still show the pay. This client sends exactly the assigned games, in order, once each,
  capped.
- `POST /shifts` doesn't check that the player applied for the career.

## 7. Careers the CT-now dossier found that the contract doesn't have

`docs/research/ct-now-2026-10.md` §4a lists jobs that people actually did on CT in Sep–Oct 2026. Most map onto the
contract's 14 careers (`docs/progress/careers.md`, "Re-check"). These have no home yet. They are candidates for
careers or gigs in a later `careers.json` / `gigs.json` revision, not requests for now:

| Candidate | Basis (dossier) | Mini-game idea |
| --- | --- | --- |
| Livestream Dev | stunt streams, creator fees to streamers | hit the chat goal without rugging (Trust drops if you rug) |
| Hackathon Builder | "60+ hackathons in October", deadline extensions | ship the demo before the (extended) deadline |
| Booth Crew | COIN2050-style conference booths, mascots | scan badges / swag toss / mascot photo |
| News-Desk Operator | JUST IN accounts, Odds Crier | post the headline first; accuracy costs time, errors cost Trust |
| P2P Merchant (gig) | Nigerian "P2P stress" (§5b) | match naira↔USDC orders, dodge chargeback scammers |

## Sources

- [Build spec](../spec/build-spec.md), Phase 4 item 29; [contract](../spec/contract.md), section 4 "Work" and section 2 `mini_games.json`.
- `contract/config/careers.json`, `contract/config/gigs.json`, `contract/ids/mini_games.json` (rc1).
- ct-life-backend 9f3e5ef: `server/application/{careers,shifts,gigs}.ts`, `server/api/routes/{work,gigs}.ts`, `server/api/middleware/idempotency.ts` (read-only).
- Game research: `docs/progress/careers.md` "Research", `docs/research/ct-now-2026-10.md` (complete version: §2a, §2b, §2c, §3a/3b, §4a, §5b, §6).
