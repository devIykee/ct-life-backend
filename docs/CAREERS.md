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

### The shift (simple clock-in)

Like The Sims: clock in at the counter, the avatar works in 3D (client animation only), pay builds
by real server time, clock out pays. The player may close the app.

1. `POST /jobs/rekt-burger/shift/start` (no body). A new shift needs the server's own fresh
   position (street room, at most 30 s old) within `counter.radiusM` (25 m) of the counter
   (`counter` in `GET /jobs/rekt-burger`), else `409 POSITION_UNKNOWN` / `409 COUNTER_TOO_FAR`.
   One open shift per player: calling it again returns that shift with `resumed: true` and needs no
   position. Returns `{shiftId, startedAt, ratePerMinuteCents, capRemainingCents, maxEndsAt,
accruedCents, serverNow, resumed, postId}`.
2. `GET /jobs/rekt-burger/shift/current` restores the shift after a relaunch: `{shift, lastShift}`.
3. `POST /jobs/rekt-burger/shift/end` (no body) pays and returns `{paidCents, minutes, seconds,
careerXp, cappedCents, capRemainingCents, uniformGranted, endReason}`.
4. A shift left running is closed and paid by the server at `maxEndsAt` (per-minute worker, or on
   the next read). `POST /jobs/rekt-burger/leave` also clocks an open shift out.

Pay is `floor(seconds x ratePerMinuteCents / 60)`, with at most `maxDurationSec` counted, trimmed to
what is left of the UTC-day cap. Ledger reason `job_rekt_burger`, ref `rekt_burger_shift`. The
client sends no amount, time or position that is trusted.

**Economics (all in `contract/config/careers.json` `rektBurger`).** The per-ticket design paid at
most 1,500 cents per shift (3 minutes of play) and 4,500 cents a UTC day, so a reasonable day of play
was about the cap, 4,500 cents. Clock-in keeps the same daily ceiling and spreads it over time:

|               | per-ticket (#16)                     | clock-in                                                             |
| ------------- | ------------------------------------ | -------------------------------------------------------------------- |
| rate          | up to 1,500 cents per 3-minute shift | 50 cents per minute (`ratePerMinuteCents`)                           |
| longest shift | 180 s                                | 3,600 s (`maxDurationSec`), 3,000 cents                              |
| daily cap     | 4,500 cents                          | 4,500 cents (`dailyCapCents`), reached after 90 minutes on the clock |

Sitting on the clock is easier than the minigame was, so the rate is far lower per minute of
attention: 90 minutes for the same day cap, against 9 minutes before. Change the three constants
to tune it.

**Career XP and quests.** A shift of at least `minCountedSec` (120 s) earns `xpPerMinute` (1) career
XP per minute, only for a player already on a career ladder (the job never enrols anyone), through
the same shared daily action-XP cap as other actions (`ladderActionXpDailyCap`, 120) and once per
shift. The same minimum applies to the `shift_complete` quest, Season XP through it, and the Rekt
Burger Uniform; a shorter shift is paid but counts for none of them, so clocking in and out cannot
farm them. The "blow your port" eligibility (Trencher, broke with debt, liquidated) is unchanged.

The old per-ticket endpoint `POST /jobs/rekt-burger/shift/finish` answers `410 GONE`.

### Timeline

- First shift after being out: a **"Back to the trenches"** post, authored by the player
  (`kind: "career"`, `meta.event: "back_to_trenches"`).
- `POST /jobs/rekt-burger/leave`: if the stint began with net worth (Cash minus debt) under
  100,000 cents, had at least one paid shift and ends at or above it, a **"Glow-up"** post
  (`meta.event: "glow_up"`).
- Each is written at most once per 24 hours per player. The text is fixed server-side.

### Quests and Season XP

A clocked-out shift of at least 120 s counts for `shift_complete` quests, and through claiming them for Season XP.

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
