# Sleuth heat, carjacking and police pursuit

Parody and **game Cash only**: nothing here touches a token, a chain or a withdrawable balance. The
Sleuth is an original character (alias `The Sleuth`, author `npc:sleuth`); it is not modelled on any real
person.

Code: `server/application/heat.ts` (pursuit, jail, bail, the Sleuth post), `player-heat.ts` (the
heat value), `server/workers/police.ts` (the referee loop), `server/realtime/rooms/vehicles.ts` (steal,
hit heat), `server/realtime/rooms/street.ts` (pursuit fan-out). Routes: `server/api/routes/heat.ts`.
Migration: `092_sleuth_heat_police`.

**All numbers are [Inference]: starting values to tune from play data.**

## Heat

One value per player, 0 to 100, halved every 24 hours (decayed when read; no job cools anyone down).

| Level    | Heat   |
| -------- | ------ |
| `cool`   | 0..9   |
| `warm`   | 10..34 |
| `hot`    | 35..69 |
| `wanted` | 70+    |

| Source                                           | Heat                                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Rug launch (Rugpull Factory, `factory_rug`)      | 35 to 50                                                                                                                       |
| Steal a player's parked vehicle (`steal_player`) | 15                                                                                                                             |
| Steal an NPC traffic car (`steal_npc`)           | 8                                                                                                                              |
| Hit a player with a vehicle (`vehicle_hit`)      | 3, at most once per 10 s per driver                                                                                            |
| Drainer job (`drainer_job`)                      | 20: **hook only**, no such job exists yet. Call `raiseHeat(ctx, userId, HEAT_DELTA.drainer_job, 'drainer_job', jobId)` from it |

Every change is a row in `player_heat_events` (source, delta, heat after).
`GET /v1/heat/me` returns `heat`, `level`, `decayAt` (when the level will have dropped), `wantedUntil`
(only while `wanted`), `pursuit` and `jail`.

## Carjacking (vehicles room)

`vehicle_enter {id, steal: true}` on:

- an **NPC traffic car**: an id that starts with `traffic_` (the client simulates traffic; the server
  only sees it when someone enters it), or
- another player's **parked** vehicle.

Rules, all checked on the server:

- Within 6 m of the player's server position (the street room's position hash), 2 messages a second, and one
  steal per player per 15 s (`RATE_LIMITED`).
- Without `steal: true` the answer is `STEAL_REQUIRED` (the client shows the Steal prompt, then resends).
- A vehicle someone is driving is `VEHICLE_TAKEN`. There is no stealing from a driver, so no griefing.
- The hovercar (`roadstar`) is **never** stealable: `VEHICLE_NOT_STEALABLE`, including a roadstar another player
  parked, and a `traffic_*` id with kind `roadstar`.
- It adds heat and **never moves ownership**: the vehicle's owner stays the player who registered it. When
  the thief exits, or after 3 minutes (the thief is put out), a player's vehicle goes back to the pose where
  its owner left it. A stolen NPC traffic car just stays where it was parked.
- The owner gets `vehicle_stolen {vehicleId, kind, by, at}` and later `vehicle_returned`.
- Server-owned bay cars (parking bays) stay public parking: not a steal, no heat.
- A jailed player cannot enter any vehicle (`JAILED`).

Limits, said plainly: the server cannot see NPC traffic, so heat for an NPC steal depends on the client
using the `traffic_` id and the flag. A cheating client gains nothing by skipping it (a free car is already free:
any client-parked id registers a car), so this only costs the honest player heat. Stealing from
**players** cannot be dodged: those vehicles are known to the server.

## Police pursuit

The referee is a worker loop (`policeTick`, every 2 s). For every player with heat 70 or more who is online
(fresh server position under 15 s), not jailed, with no pursuit running and more than 120 s since the last
one, it starts a pursuit:

- `units` = 1 at heat 70..79, 2 at 80..89, 3 at 90..99, 4 at 100.
- The pursuit lasts 180 s. The **last wanted position** is where the player stood when it started.
- A player standing within 40 m of their own home door is not chased yet: police do not raid the doorstep.
- `police_pursuit {pursuitId, targetUserId, units, heat, startedAt, expiresAt, escapeRadiusM, escapeSeconds, at}` goes to the
  player (city room) and to everyone in the street room that holds the player, so bystanders see the same
  cruisers. The client spawns the AI cruisers. `police_pursuit_end` ends them.

### Who decides caught or escaped: the server

The cruisers are client AI, so the server cannot see them. The design that cannot be cheated is **position plus
timers, judged by the server from data the client cannot write**:

- Positions live in the `ctl:pos` hash, written only by the street, venue and vehicle rooms after their
  speed, bounds and teleport checks. The client has no way to put a number there.
- **Escape** (the referee decides; there is no endpoint for it):
  - stay more than **200 m** from the last wanted position for **60 s in a row**; the clock resets when you come
    back inside 200 m, and **a missing or stale position resets it too**, so going offline or hiding gives
    no credit; or
  - reach your own **home door** (within 8 m), if the chase did not start within 40 m of it (a safe house).
- **Caught**:
  - the **timer**: if the 180 s run out without an escape, the player is caught. A client that ignores the
    police, or never reports, is caught anyway; or
  - the client's report, `POST /v1/heat/caught {pursuitId, x, z}` (6 a minute): believed only for the caller's own
    active pursuit, at least 10 s old, with a server position for the player under 15 s old, and the reported
    position within 15 m of it (`CATCH_NOT_VERIFIED`, 422). A false report can only jail the reporter.
- Trade-offs: a very fast vehicle can reach 200 m and wait out 60 s (an easy escape; if too easy, raise the
  radius or time, or move the anchor along with the player). Hiding indoors (a venue room) still records an
  island position for CT Island venues, so it is not an escape either.

### Caught

- Heat drops to 40%.
- The player is put in **CT Jail** (venue `ct_jail`, "Compliance Jail"): `player_jail` with `jailed_until` and a bail.
  - Stay: 90 s plus 3 s per heat point (about 5 to 6.5 minutes at heat 70..100).
  - Bail: heat times 50 cents, at least 1,000 cents (3,500 at 70, 5,000 at 100). Whole cents, fixed at arrest.
- `jailed {venueId, jailId, until, bailCents, heat, at}` goes to the player; the client puts them in the `ct_jail`
  room.
- `POST /v1/heat/bail` (Idempotency-Key) debits the bail from Cash (ledger reason `police_bail`, a sink, `INSUFFICIENT_CASH` if short)
  and frees them. Otherwise the stay ends at `until` and `released {reason: "timer"}` is sent.
- **The Sleuth posts** a Timeline "busted" post: `kind: "sleuth"`, `meta {event: "busted", subjectUserId, subjectAlias, heat,
bailCents, deepLink: "venue:ct_jail"}`, text templated in our own words (six variants). Rate limits: one per player
  per 30 minutes (an arrest inside it still jails) and at most 10 busted posts overall per 10 minutes.
  The Rugpull Factory's exposé posts have no `meta.event`; treat a missing one as the rug exposé.

### Escaped

Heat drops to 50%, no jail, no post. `police_pursuit_end {outcome: "escaped"}` is sent.

## Jail restrictions

While in CT Jail (`403 JAILED`, with `details {until, bailCents}`):

| Blocked                                                                                         | Still allowed                        |
| ----------------------------------------------------------------------------------------------- | ------------------------------------ |
| Launching coins (Rugpull Factory and the house launchpad), buying coins, opening perps          | Selling, closing perps and positions |
| Casino bets                                                                                     | Reading anything, `GET /heat/me`     |
| Entering vehicles (`vehicle_enter` is `JAILED`)                                                 | `POST /heat/bail`                    |
| Joining any venue room except `ct_jail`; `GET /venues/{id}/access` is `JAILED` for other venues | Chat, DMs, the Timeline              |

Reasoning: a jailed player cannot open new risk or move around, but is never stopped from getting out of a
position (a liquidation should not be a jail side effect). The venue room join fails open if the database
is unreachable; the REST gates still hold. Shifts and other jobs are not blocked: they need the player to be at a venue.

## Frontend contract

- **Steal prompt:** near a parked player vehicle or a `traffic_*` car, show "Steal"; send `vehicle_enter {id, steal: true}`.
  Handle `STEAL_REQUIRED` (resend with the flag), `VEHICLE_NOT_STEALABLE`, `VEHICLE_TAKEN`, `JAILED`, `RATE_LIMITED`. On `vehicle_returned`
  to a thief, you are out of the car. Owners show a toast on `vehicle_stolen`.
- **HeatPlate:** `GET /v1/heat/me` on login and on every `police_pursuit`, `jailed`, `released`; heat and `level` drive the plate; poll
  at most every 30 s while `wanted`.
- **Police AI:** on `police_pursuit`, spawn `units` cruisers (once per `pursuitId`) chasing `targetUserId`; on contact for a couple of
  seconds call `POST /v1/heat/caught {pursuitId, x, z}` with the player's current island position. On `police_pursuit_end` despawn.
  Do not report escapes: the server decides.
- **Jail and bail UI:** on `jailed` (or `me.jail`), load the `ct_jail` venue, show a countdown to `until` and a "Pay bail" button
  (`POST /v1/heat/bail`). On `released`, open the door.
