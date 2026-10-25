# Careers: ladders and Rekt Burger

Two layers on top of the existing job and shift system (`GET /careers`, `POST /shifts`).
Numbers live in `contract/config/careers.json`; this file explains the rules.

## 1. Career ladders

Five ladders, one per Crypto Twitter archetype: **Builder, Trader, Caller, Farmer, Founder**.
A ladder does not add jobs. It names which of the existing jobs earn its XP (`jobIds`) and
which tribes it suits (`tribeIds`):

| Ladder  | Tribes                       | Jobs (ids from `careers`)                       |
| ------- | ---------------------------- | ----------------------------------------------- |
| Builder | builder                      | junior_analyst, dev_rel, smart_contract_auditor |
| Trader  | perp_degen, prediction_shark | junior_analyst, alpha_lead                      |
| Caller  | caller                       | kol_engagement, shill_runner, kol_manager       |
| Farmer  | airdrop_farmer               | discord_mod, yield_farmer                       |
| Founder | (none; chosen)               | discord_mod, dev_rel                            |

Trencher and Anon have no ladder of their own; they can join any. Jobs that are not yet
active (`active: false` in the job list) start paying XP when they open.

### Ranks

Seven per ladder: Intern, Junior, Mid, Senior, Lead, Head, Legend (titles differ per
ladder, e.g. "Builder Intern" to "Builder Legend"). `xpRequired` is cumulative:

| Rank | XP     | Pay bonus | Also                             |
| ---- | ------ | --------- | -------------------------------- |
| 1    | 0      | 0%        |                                  |
| 2    | 200    | +3%       |                                  |
| 3    | 600    | +7%       | cosmetic (accessory)             |
| 4    | 1,500  | +12%      | venue-area flag                  |
| 5    | 3,500  | +18%      | cosmetic (top)                   |
| 6    | 7,000  | +26%      | venue-area flag                  |
| 7    | 12,000 | +35%      | cosmetic (head: the Legend halo) |

The **pay bonus** is added to the Cash of a shift on one of the ladder's jobs, in whole
cents rounded down (`floor(base * bps / 10000)`), inside the same transaction as the pay.
Shifts on other jobs are not boosted. A venue-area flag is `venueId:area`
(for example `perp_pit:high_roller_floor`); the server reports it, the client decides what
opens. `GET /venues/{id}/access` returns `careerAreas` for that venue.

### XP

Only the server awards XP, and only to the ladder the player is on:

- A paid shift on a ladder job: that shift's own XP (0 to 100).
- Related actions, per `actionXp` of the ladder. Trader: perp open 4, perp close 8,
  prediction 4. Caller: alpha call 15, paid call 12, tip 3. Farmer: airdrop claim 20, home
  visit 4. Builder: project founded 10, project launched 25. Founder: founded 25,
  launched 40. They arrive through the same hooks as the quests (`recordQuestEvent`), plus
  the airdrop and project services.
- Action XP is capped at `ladderActionXpDailyCap` (120) per ladder per UTC day. Shift XP is
  not capped here; shifts are throttled by their own length.
- Every award is one `ladder_xp_events` row keyed `(user, source, ref)`: a replayed hook or
  shift never pays twice.

### Joining and switching

`POST /careers/{ladderId}/join`. The first deliberate join is free. Moving to a different
ladder needs `ladderJoinCooldownHours` (72) since the last deliberate join, else
`409 CAREER_SWITCH_COOLDOWN` with `details.retryAt`. XP and rank are stored per ladder, so
switching back restores them, but only the ladder you are on earns XP and pays perks. A
player who never chose is enrolled by their first paid shift on a ladder job (the one
matching their tribe if there is one); that does not start a cooldown.

### Promotion

Automatic and server-side: when XP crosses a threshold, the rank rises in the same
transaction as the XP, the rank's cosmetic is granted (once), and the player gets the
realtime `career_promoted`. Several ranks in one go are one event (`fromRank` to `toRank`;
`venueAccess` and `cosmeticIds` list everything newly granted).

## 2. Rekt Burger, the "blew my port" job

Our own parody brand. It never uses any real chain's name, logo or likeness; the client
must keep it that way (original art, original name).

### Who has it

- **Trenchers**: pre-unlocked, as their safety net.
- **Everyone else**: unlocked **for good** when Cash is at or below 0 while in debt (checked
  when the job is read or a shift is started), or right after a perp liquidation leaves
  Cash under 2,000 cents. The realtime `job_unlocked` tells them. Cash at 0 with no debt, or
  a little Cash with debt, does not unlock it.

`GET /jobs/rekt-burger` returns `unlocked`, `reason` (`trencher | broke | liquidated`), a
`lockedHint` while locked, the employment state, pay, the daily cap and the open shift.

### The shift

1. `POST /jobs/rekt-burger/shift/start` (no body). The server records the start time. It
   returns `minFinishAt`, `expiresAt` and the `rules`. Calling it again while a shift is open
   returns that shift (`resumed: true`).
2. The client plays the minigame (tickets appear; the player assembles and serves them).
3. `POST /jobs/rekt-burger/shift/finish`:
   `{ "result": { "orders": [{ "i": 0, "startedMs": 3200, "servedMs": 9400, "correct": true }, ...] } }`
   Times are milliseconds since the shift started. `shiftId` is optional (defaults to the
   open shift).

The request has **no amount**, and unknown fields are rejected. The server pays
`300 + 60 * min(correct, 20)` cents (so 1,500 at most), then trims to what is left of the
4,500 cents a UTC day. Ledger reason `job_rekt_burger`, ref `rekt_burger_shift`.

### Plausibility (server clock, not the client's)

A report is rejected as `422 SHIFT_RESULT_IMPLAUSIBLE` (and the shift is **burned**, so tuned
numbers cannot be retried) unless: at least 3 and at most 40 orders; tickets numbered
0..n-1 in order; each served no sooner than 1,200 ms after it appeared and no later than
30,000 ms; serves at least 900 ms apart; nothing served after the shift ended (1,500 ms
network tolerance); and, from 5 orders, not both serve times and gaps machine-regular
(standard deviation under 15 ms). Finishing before 45 s is `400 SHIFT_NOT_FINISHED` (the
shift stays open); after 180 s the shift is void (`409`).

This stops impossible and lazy bot reports. A bot that fakes human-looking timing within
those bounds can still earn, which is why the pay is small and capped per day.

### Timeline

- First shift after being out: a **"Back to the trenches"** post, authored by the player
  (`kind: "career"`, `meta.event: "back_to_trenches"`).
- `POST /jobs/rekt-burger/leave`: if the stint began with net worth (Cash minus debt) under
  100,000 cents, had at least one paid shift and ends at or above it, a **"Glow-up"** post
  (`meta.event: "glow_up"`).
- Each is written at most once per 24 hours per player. The text is fixed server-side.

### Quests and Season XP

A finished shift counts for `shift_complete` quests, and through claiming them for Season XP.

## 3. What the client needs

**Careers screen** (`GET /careers?view=ladders`). The default `GET /careers` still returns
the old job array; do not change it. Render the five ladders; mark `active` and `suggested`;
for the active one show title, `xp`, `xpToNext`, `nextRank`, the `ranks` track with
`status`, `payBonusBps` as "+N% pay", and `canSwitchAt` as a countdown on the other ladders'
Join buttons. `venueAccess` (and `GET /venues/{id}/access` `careerAreas`) say which areas
the rank opens.

**Promotion celebration.** On the realtime `career_promoted`: a card with `title`, the pay
bonus, any `venueAccess` and the new cosmetics (`cosmeticIds` are `reward_career_*`
inventory items, `GET /inventory`). Refetch the ladders. Also read `ladder.promoted` in the
shift response.

**Rekt Burger venue.** It sits in the `venueId` the response gives (`the_trenches`), at
`propId` (`rekt_burger_counter`): the counter to walk up to. Hide it while `unlocked` is
false (or show "Rekt Burger is hiring" on `job_unlocked`). Show `pay.earnedTodayCents` /
`dailyCapCents`.

**Minigame inputs.** Show the tickets; record for each: its running index `i` from 0, the
time it appeared (`startedMs`), the time the player served it (`servedMs`), and whether it
was assembled right (`correct`). Do not send a score or a pay. Keep the shift between
`minFinishAt` and `expiresAt`; keep serve times between `minServeMs` and `maxServeMs`; do
not finish with fewer than `minOrders`. Vary the tickets (random items, random spawn gaps)
so honest timing is naturally irregular.

**Uniform cosmetic.** `reward_rekt_burger_uniform` (top slot) is granted on the first paid
finish (`uniformGranted: true`) and shows in `GET /inventory`. The client wears it behind
the counter; whether it shows outside is the client's choice.

**Timeline.** `GET /feed` posts with `kind: "career"` render like player posts, plus a
badge from `meta.event`; `meta.deepLink` is `venue:the_trenches`.
