# ORE staking unlock: read-only audit, 2026-10-11

**The current backend cannot verify a staked-ORE unlock.** No ORE implementation,
wallet, transaction or chain state was changed during this audit.

## Findings in the repository

- `server/application/refinery.ts:readOreMe` unconditionally returns zero ORE,
  staked ORE and stORE balances. It only reads `users.miner_tier`; there is no
  production RPC branch despite the preceding comment.
- `readBoard` asks RPC for the program account, then returns a constructed `live`
  board with zero-valued state. It does not decode a board account.
- `markStakeSubmitted` checks intent ownership and stores the submitted signature.
  This function does not verify a transaction, finality, stake position or amount.
- `server/shared/solana/ore-stake.ts` builds 8-byte Anchor-style instruction hashes,
  combines ORE and stORE accounts and omits the treasury/vesting accounts required
  by the current official direct-staking builders. Tests which repeat the local
  encoding/account assumptions do not prove current program compatibility.

## Verified primary-source comparison

The official direct-staking program has the same program ID used locally, but its
current instruction enum uses single-byte discriminants: deposit 10, withdraw 11,
claim 12 and compound 13. Deposit arguments also include compound fee and fee
deposit, and claim carries an amount. See the official
[instruction definitions](https://github.com/regolith-labs/ore-stake/blob/master/api/src/instruction.rs),
[program ID](https://github.com/regolith-labs/ore-stake/blob/master/api/src/lib.rs)
and [builders](https://github.com/regolith-labs/ore-stake/blob/master/api/src/sdk.rs).

The stake state contains an authority and balance, alongside reward and fee fields.
That is a concrete source for a future read-only position verifier, after pinning
the deployed layout and validating account ownership and discriminator. See the
[official state](https://github.com/regolith-labs/ore-stake/blob/master/api/src/state/stake.rs).

stORE belongs to the separate liquid-staking protocol, whose operations are
wrap/unwrap/compound; it must not be treated as an account automatically produced
by direct ORE staking. See [ORE LST](https://github.com/regolith-labs/ore-lst).

## Recommendation and unverified work

Keep a staking unlock unavailable until an authenticated server reader verifies the
wallet's position from a pinned deployed protocol, with explicit RPC freshness and
failure state. Missing/unavailable data must not be reported as a verified zero.
Choose direct ORE stake or stORE eligibility explicitly before implementing the
gate. A submitted client signature and a local miner tier are insufficient proof.

This audit compared source, not deployed bytecode or live stake accounts. Mainnet
program deployment, mint decimals, current account layouts and an independent
transaction simulation remain unverified. No stake transaction was signed,
broadcast or simulated, and no financial transfer was requested. The existing
staking builder needs a separately scoped correction before it is offered to users.
