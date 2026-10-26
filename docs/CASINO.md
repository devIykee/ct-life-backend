# The Rug Room (casino)

A Cash-only, play-money casino, 18+. Code: `server/application/casino.ts` (service),
`casino-math.ts` (pure maths), `server/api/routes/casino.ts` (routes). Tunables:
`contract/config/casino.json` and two env caps. API: `contract/openapi.yaml` (tag `casino`).

## Policy rules (binding)

| Rule                                 | How it is enforced                                                                                                                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cash only, play money                | Stakes and payouts are `balances.cash_cents` and ledger rows `casino_stake`, `casino_win`, `casino_refund`. There is no cash-out endpoint and no SOL, USDC, SKR or ORE path. Nothing tradable is paid.                               |
| No NFT or tradable prizes            | None are granted. A jackpot flag (`outcome.jackpot`) exists so the client can show a cosmetic that is off-chain and untradable; no cosmetic is granted by the backend in this PR.                                                    |
| 18+ only                             | `characters.age_confirmed_at` (set by the onboarding 18+ checkbox) must be set. Otherwise `403 AGE_REQUIRED`, before anything is debited. A player with no character is refused too.                                                 |
| Daily stake cap                      | `CASINO_DAILY_STAKE_CAP_CENTS`, default 50,000. A stake that would take the day's total past it is `403 STAKE_CAP_REACHED`.                                                                                                          |
| Daily net-loss cap                   | `CASINO_DAILY_LOSS_CAP_CENTS`, default 25,000. A stake that would take the day's net loss past it is `403 LOSS_CAP_REACHED`. (It is checked against the stake, the worst case of that round, so the cap is never exceeded.)          |
| Session reminder                     | Every casino response carries `sessionMinutes` (continuous play; a gap over 10 minutes ends the session) and `sessionReminder`, true from 30 minutes. The client shows the break popup.                                              |
| Self-exclusion                       | `POST /v1/casino/self-exclude {days: 1..365}`. New stakes are `403 SELF_EXCLUDED` until the date. It can be extended, never shortened or lifted early. An open crash round can still be cashed out and a pending challenge refunded. |
| Disclaimer                           | Every success response carries `disclaimer: "Play money. No cash value. 18+"`.                                                                                                                                                       |
| No gambling ads, no real-money links | Product rule for the client (plan P2). The backend has no such surface.                                                                                                                                                              |

Caps are counted from the ledger for the UTC day, so they include stakes held in escrow
and exclude refunded stakes. Casino actions of one player are serialized by a lock
on their `casino_players` row, so two parallel bets cannot slip past a cap.

## Anti-grinding: the rich list

`BoardsService` (`server/application/boards.ts`) computes the boards in SQL from `balances` and
`ledger_entries`. Casino profit now counts at **25%** on the two wealth boards (constant
`CASINO_RICH_LIST_WEIGHT_PCT`):

- `net_worth` = cash - debt - 75% of max(0, lifetime casino net), where casino net is the sum of
  the `casino_stake`, `casino_win` and `casino_refund` ledger rows.
- `weekly_pnl` = ledger sum of the last 7 days with the casino rows replaced by 25% of their net
  when that net is positive.

A net casino loss counts in full (it is Cash the player really lost). `clout` is unaffected.
Not changed: `netWorthCents` on the public profile and the Dubai Marina net-worth gate in
`venues-gating` still use plain cash minus debt, so a gambler can still buy their way past that
gate; if that is not wanted, the same expression is one line to reuse there.

## The games

All three: stake 100 to 10,000 cents (config), integer cents, payout floored to a whole cent.

### Slots

Three independent reels over the same weighted symbols (`rocket 5, diamond_hands 9, ape 13,
laser_eyes 8, rug 10, wild 2`, out of 47). A wild stands in for any symbol except the rug; three
wilds are the jackpot. The best symbol (counting wilds) pays the `three` multiplier on three and
the `two` multiplier on two; a rug never pays and a wild does not rescue it. Paytable (in
`casino.json`): three of a kind rocket 30x, laser_eyes 15x, diamond_hands 10x, ape 5x, wild 25x;
two of a kind rocket 1.5x, laser_eyes 1.5x, diamond_hands 1x, ape 0.5x.

RTP is the sum over the 216 reel combinations of probability x multiplier: **95.05%**, hit rate
48.8% (counting the 0.5x and 1x returns), sigma 2.6 stakes per spin. `pnpm contract:check`
recomputes it and fails outside 94 to 96% or if `computedRtp` in the file is stale.

### Crash ("moon or rug")

One uniform draw `U` gives the crash point `max(1, floor(0.95 * 100 / (1 - U)) / 100)`, capped at
100x. So `P(crash >= m) = 0.95 / m`, and cashing out at any fixed target `m` returns 0.95 in
expectation: **RTP 95%** whatever the strategy. About 5.9% of rounds show 1.00x (anything under
1.01x), which nobody can cash out of.

The displayed multiplier is `e^(0.07 t)` for `t` seconds since the round started (2x after 9.9 s,
10x after 33 s, 100x after 66 s). The round ends at `t_crash = ln(crash) / 0.07`.

- With `autoCashout` the round settles at the bet: a win if the target is at or below the crash
  point. The client animates the outcome it is given.
- Without it the round is `open`. The response carries `params.startedAtMs` and
  `params.growthPerSecond` for the animation, never the crash point or the seed.
  `POST /crash/cashout` is decided only by the server clock: if `now - startedAtMs >= t_crash` the
  round is lost (payout 0, seed revealed), else it pays `floor(100 e^(0.07 t)) / 100` times the
  stake. A second cashout is `409 ROUND_SETTLED`. Client latency is not compensated: a cashout that
  arrives after `t_crash` loses.
- One open crash round per player (also a unique index). A round past its crash time is closed as a
  loss by the player's next bet or round listing, or by the per-minute sweep.

### Coinflip

- **Against the house**: call heads or tails; a win pays 1.9x (RTP 95%).
- **Head-to-head (bragging rights, no Cash)**: `POST /coinflip/challenges` to a named player,
  with a side and nothing else. Cash never moves between players, so there is no stake, no
  escrow, no pot, no house cut, no `casino_*` ledger row and no `casino_rounds` row. The
  opponent has 120 seconds to accept; the coin comes from the committed seed and the winner is
  recorded on the challenge. 18+ and self-exclusion still apply (the stake caps do not, nothing
  is staked). Only the two players can see or act on a challenge (others get 404). Migration 099
  cancelled every challenge that still held an escrowed stake and returned it (ledger
  `casino_refund`); old settled challenges keep their stake columns as history.

## Fairness: commit and reveal

Per round the server draws a 32-byte seed from `crypto.randomBytes`. It publishes
`seedHash = SHA-256(seed as a 64-character hex string, UTF-8)` when the round opens (for a
head-to-head, when the challenge is created) and reveals `seed` when it settles. The client sends no
seed or nonce, so it cannot influence the result. Every draw is
`HMAC-SHA256(key = seed, "<game>:<roundId>:<counter>")`, counter from 0; the first 53 bits give a
float in [0, 1). To verify a settled round:

1. check `SHA-256(seed) == seedHash`;
2. recompute the draws with the game label (`slots`, `crash`, `coinflip`, `coinflip_h2h` with the
   challenge id in place of the round id) and apply the game rule above: slots take three draws,
   one per reel, by cumulative reel weight; crash and coinflip take one (`< 0.5` is heads).

`GET /v1/casino/rounds?mine` is the audit log: your own rounds only, and a round's seed is never
returned while it is open. Table `casino_rounds` keeps game, stake, payout, outcome, `seed_hash` and
`seed`.

## Money flow and ledger

One transaction per action: lock `casino_players`, lock `balances`, check the gates, write
`casino_stake` (negative), `casino_win` (positive, only when the payout is above 0), the
`casino_rounds` row. Ledger `ref_type` is `casino_round` or `casino_challenge`; `idempotency_ref` is
`casino-stake|win|refund:<userId>:<roundId or challengeId>`. HTTP bets also use the Idempotency-Key
middleware, so a retry replays the first answer and charges once. Bets are rate limited (burst 5,
2 per second per player) on top of the global write limit.

## Tables (migration 1700000086000)

`casino_players` (exclusion and the per-player lock), `casino_rounds`, `casino_challenges`, and a
partial index on `ledger_entries (user_id)` for the casino reasons (used by the rich-list SQL).

## Measured (1,000,000 rounds each, seeded RNG, `casino-math.test.ts`)

| Game                                     | Exact  | Simulated                         |
| ---------------------------------------- | ------ | --------------------------------- |
| Slots                                    | 95.05% | 94.74%                            |
| Crash, auto-cashout 1.5x / 2x / 5x / 10x | 95.00% | 95.07% / 94.94% / 94.84% / 94.95% |
| Coinflip vs house                        | 95.00% | 95.02%                            |

## Not built yet

Blackjack and roulette (plan §5.1, games 4 and 5), the Dubai Marina high-roller room gating,
`casino_win` world announcements for big wins (they would need a rate-limited broadcast in the
`city` room), and the off-chain jackpot cosmetic (needs the frontend's cosmetic ids).
