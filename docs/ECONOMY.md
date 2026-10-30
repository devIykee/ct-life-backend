# Economy

> Every faucet and sink, tax brackets, rent, top-up packs and bonuses, every formula, and the latest `econ-sim` results. Every number in `contract/config/economy.json` is explained here.

The full content lives in M2 onward. This is the table of contents and the rules that govern the numbers.

## The Cash model: purchasable, non-transferable, no cash-out, no on-chain

- **Purchasable**: Cash is bought with crypto top-ups (USDC, SOL, SKR, ORE) into the buyer's own
  account.
- **Non-transferable**: Cash never moves between players. There are no Cash tips
  (`POST /tips` answers `410 CASH_NOT_TRANSFERABLE`), no Cash stakes between players (heads-up
  casino challenges are stake-free bragging rights), and no paid-call settlement in Cash (the
  creator's share is paid on-chain in USDC by the escrow program; the game credits nobody).
- **No cash-out**: nothing converts Cash to money.
- **No on-chain**: nothing bought with Cash, or earned by playing, can be minted
  (`POST /nft/mint` answers `403 NFT_MINT_NOT_ALLOWED` unless the item was acquired on-chain).
  An on-chain tip is a wallet-to-wallet transfer; the game only records an informational note and
  never credits Cash for it.
- Cash is credited to a player only for their OWN top-up, their own play, or a reward.
- **Builder projects** (unlock B1): a founder's Cash only goes into their own project treasury
  (seed, `POST /projects/{id}/fund`), and the treasury only into sinks (launch, the weekly
  operating cost, risk losses); it is never withdrawable. A member's wage is a fixed band from
  `contract/config/projects.json`, paid by the game for a week they worked, and the treasury pays
  a matching operating cost in the same run. One role per player. `POST /projects/{id}/hire`
  (founder paid the hire directly) answers `410 GONE`.

## Cash units

- Cash is int64 cents. `$500` = `50000` cents. The field name in every API response ends in `Cents`.
- Coin units are int64 base units with 6 decimals. The field name ends in `Units`.
- Token amounts are strings in base units: `amount`, `ratePerMinUsdc`, `priceUsdc`, `creatorAmount`, `refundAmount`, `motherlodeOre`, `cityStakedOre`, `deployedLamports`, `balance`, `staked`, `stOre`.
- `priceUsd` is a display-only decimal string, never used in math.

## Faucets (Cash in)

| Source                    | Spec section | Notes                                                |
| ------------------------- | ------------ | ---------------------------------------------------- |
| Birth lottery: Insider    | spec 4       | $3,000 + Studio                                      |
| Birth lottery: Seeker     | spec 4       | $1,500 + Hacker House (if SGT verified)              |
| Shifts                    | spec 4       | pay from `careers.json`, capped by `mini_games.json` |
| Gigs                      | spec 4       | pay from `gigs.json`                                 |
| Businesses                | spec 4       | income from `businesses.json`, minus bad-day losses  |
| Daily alpha clue          | spec 4       | small Cash prize                                     |
| Weekly Meta bonus         | spec 4       | per `meta.json`                                      |
| Rent rebates / promotions | spec 4       | TBD                                                  |
| Cash top-ups (real money) | spec 4       | USDC, SOL, SKR, ORE; ORE 15% bonus, SKR 10%          |
| Project wages (Builder)   | unlock B1    | game-paid weekly band, worked weeks only             |

## Sinks (Cash out)

| Sink                              | Spec section | Notes                                    |
| --------------------------------- | ------------ | ---------------------------------------- |
| Rent                              | spec 4       | per `homes.json`; weekly; 4 misses evict |
| Gas bill                          | spec 4       | per city district                        |
| Food                              | spec 4       | per `needs.json`; need action `eat`      |
| Tax                               | spec 4       | brackets in `economy.json`; weekly reset |
| Gear                              | spec 4       | items from `items.json`                  |
| Business costs                    | spec 4       | per `businesses.json`                    |
| Rug losses                        | spec 4       | fictional coin losses                    |
| Bail                              | spec 4       | after moderation                         |
| Cosmetics (Cash items)            | spec 4       | shop purchases                           |
| Trade fees                        | spec 4       | per trade                                |
| Project treasury (player-founded) | unlock B1    | seed, fund, launch, matching op cost     |

## Tax brackets (weekly, resets Mon 00:00 UTC)

| Weekly income (cents)  | Rate |
| ---------------------- | ---- |
| First 500,000 ($5,000) | 0%   |
| 500,000 to 1,500,000   | 20%  |
| 1,500,000 to 5,000,000 | 40%  |
| Above 5,000,000        | 45%  |

## Rent (weekly)

| Home              | Per week (cents) |
| ----------------- | ---------------- |
| Parent's Basement | 2,000            |
| Hacker House      | 6,000            |
| Studio            | 18,000           |
| Penthouse         | 150,000          |
| Marina Villa      | 500,000          |

## Top-up packs

| Pack  | USDC | Cash (cents) | Notes   |
| ----- | ---- | ------------ | ------- |
| Ramen | 1    | 50,000       | $500    |
| Bag   | 5    | 300,000      | $3,000  |
| Whale | 10   | 700,000      | $7,000  |
| Cabal | 20   | 1,600,000    | $16,000 |

- SOL, SKR, ORE accepted at the live quote.
- ORE bonus: +15% Cash (`bonusBps=1500`).
- SKR bonus: +10% Cash (`bonusBps=1000`).
- Daily cap: 100 USDC of top-ups per wallet per day (enforced at the intent API, returns `TOPUP_CAP_REACHED`).

## Formulas

- **Net Worth** = `cashCents + open positions at last price + perp margin + unrealized perp PnL − debtCents`. Recomputed per board refresh.
- **Weekly PnL** = `realizedCents over the last 7 days from positions and perps` (sums of realized entries).
- **Perp liquidation price** (long): `entryMicros * (1 - 1/leverage)`. (Short): `entryMicros * (1 + 1/leverage)`. The cap is by the Trading skill and tribe (`skills.json`).
- **Bonding curve** (M3): constant-product `x*y=k` with virtual reserves. Graduates to an `x*y=k` pool at a market-cap threshold from `market.json`.
- **Trade fee** (M3): flat bps from `market.json`; both buyer and seller pay.
- **Shift pay** (M2): `pay_per_level * min(1, score / maxScore)` capped at `maxScore` from `mini_games.json`. `SHIFT_NOT_FINISHED` if completed before `durationSec`.
- **Liquidation engine**: per tick, the engine evaluates each open perp at the new price. The position is liquidated when the price crosses the liq threshold. A tombstone row is inserted and a `liquidated` message is pushed to the city room.

## econ-sim

`tools/econ-sim` runs 1,000 synthetic players for 8 weeks using the real config and ledger rules. It is run at the end of M2 and again at M5, with results appended below.

The first `econ-sim` will run at the M2 gate. Until then, the file is stubbed and the script is a placeholder.

## Currency decimals

| Token | Decimals                              | Mint (mainnet)                                 | Notes                                                      |
| ----- | ------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------- |
| USDC  | 6                                     | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | Devnet mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |
| SOL   | 9                                     | (native)                                       | `mint` is null in PaymentIntent                            |
| SKR   | from `economy.json` (verify on chain) | `SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3`  | Devnet mint unverified                                     |
| ORE   | 11                                    | `oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp`  | Mainnet only; `TransferChecked`                            |

## Config invariants

- `bonusBps` is a per-currency setting in `economy.json`. The sum of (cashCents paid out) over (USDC in) is `1 + bonusBps/10000` at the moment of the intent. The bonus is locked in when the intent is created, not when it is confirmed.
- `topupCapCents` (100 USDC) is per wallet per UTC day, computed from the sum of confirmed `topup` intents' cashCents. A request that would push the day over the cap returns `TOPUP_CAP_REACHED`.
- The spec says "the start of life is the birth lottery, forced once per account". The lottery is server-rolled, outcomes `seeker` (only if SGT verified), `insider`, `exit_liquidity`. Weights in `lottery.json`.
- The Exit Liquidity debt is `$720` repaid at `$120/week` with a `10%` penalty if missed (Sunday Unlock). The penalty is recorded as a `reason=penalty` ledger entry.

## See also

- `contract/config/economy.json` — every number lives here, with units in the JSON Schema.
- `tools/econ-sim` — the simulator that asserts the numbers are sane.
- `docs/DATA_MODEL.md` — the ledger tables.
- `docs/ONCHAIN.md` — payment verification algorithm.
