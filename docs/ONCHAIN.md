# Onchain

> Every program, PDA, instruction, account, event and error for `ct_escrow`; the payment verification algorithm step by step; the ORE read and stake flows with the ported instruction builders and their source references; devnet and mainnet addresses.

The full content lands in M3 (Anchor tests + IDL commit) and M4 (deployed program + paid-call flow). M0 ships the directory layout and the address audit.

## ct_escrow program

The paid-call escrow on Solana. Adapted from the Anchor escrow example. Anchor 0.31 client, Solana CLI 3.1.10, Rust crate `anchor-lang = "0.31.1"`. **The program has no admin withdraw.** The on-chain Session enforces `1 <= max_minutes <= 60`, and `settle()` / `refund()` must mark the session as `status = 2` or `status = 3` before closing the vault.

### Accounts

**Config PDA** — seeds `["config"]`:

- `admin: Pubkey`
- `settle_authority: Pubkey` — the backend's key (`SETTLE_AUTHORITY_KEYPAIR_*`)
- `treasury: Pubkey` — USDC account owned by the backend
- `usdc_mint: Pubkey`
- `fee_bps: u16` (1000 = 10%)
- `accept_window_secs: u32` (120)
- `bump: u8`

**Session PDA** — seeds `["session", fan, creator, session_id_le_bytes]`:

- `fan, creator: Pubkey`
- `session_id: u64`
- `rate_per_min: u64` (USDC base units)

Known oddities: `Config` includes an extra `vault` field from the original escrow example, and `Session.vault_bump` is unused even though the account layout still carries it. Neither should be removed or reordered for compatibility.
- `max_minutes: u16`
- `deposit: u64` (rate × max × (1 + fee_bps/10000))
- `fee_bps: u16` (copied from Config at `open`)
- `opened_at: i64`
- `accepted_at: i64` (0 until accepted)
- `status: u8` — 0 Open, 1 Accepted, 2 Settled, 3 Refunded
- `bump: u8`

**Vault** — the Session PDA's USDC associated token account.

### Instructions

| Instruction                                           | Signer                  | Effect                                                                                                                                                                                                          |
| ----------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init_config(fee_bps, accept_window_secs)`            | admin                   | Runs once.                                                                                                                                                                                                      |
| `open_session(session_id, rate_per_min, max_minutes)` | fan                     | Creates the Session and vault. Moves `rate × max × (1 + fee_bps/10000)` from the fan to the vault.                                                                                                              |
| `accept()`                                            | settle_authority        | Sets `accepted_at`. Called after the creator taps Accept.                                                                                                                                                       |
| `settle(seconds_used)`                                | settle_authority        | `minutes = ceil(seconds / 60)` capped at `max`. Pays the creator `rate × minutes` and the treasury that × `fee_bps/10000`, refunds the remainder to the fan, closes the vault and Session with rent to the fan. |
| `refund()`                                            | fan or settle_authority | Refunds everything to the fan if `status = Open` and the accept window has passed, or `status = Accepted` and more than `max × 60 + 600` s have passed since `opened_at`.                                       |

### Events

- `SessionOpened { session_pda, fan, creator, rate_per_min, max_minutes, deposit }`
- `SessionAccepted { session_pda, accepted_at }`
- `SessionSettled { session_pda, minutes, creator_amount, fee, refund }`
- `SessionRefunded { session_pda, refund }`

### Errors

- `InvalidRate` — `rate == 0` or `rate > 50 USDC` per minute. The API enforces `0.25 <= rate <= 50` USDC/min; the program enforces only `0 < rate <= 50`.
- `TooEarlyForRefund` — refund before the accept window or expiry.
- `AlreadyClosed` — double settle or double refund.
- `Unauthorized` — wrong signer.
- `MathOverflow` — overflow in `rate * max * (1 + fee_bps/10000)` or `minutes * rate`.

### Anchor tests (M3 gate)

- Happy path split math (ceil minutes, cap, 10% fee, refund remainder, rent to fan).
- Refund after accept window.
- Refund after `max + 600 s`.
- Unauthorized signers.
- Double settle (`AlreadyClosed`).
- Overflow (`MathOverflow`).
- Invalid rate (`InvalidRate`).
- Fuzz the settle math with `proptest`.

## Mints and addresses

| Token / account            | Mainnet                                        | Devnet                                         | Notes                              |
| -------------------------- | ---------------------------------------------- | ---------------------------------------------- | ---------------------------------- |
| USDC mint                  | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | 6 decimals                         |
| SKR mint                   | `SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3`  | unverified                                     | decimals from `economy.json`       |
| ORE mint                   | `oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp`  | n/a (mainnet only)                             | 11 decimals                        |
| stORE mint                 | `storenSbvkfzircixnaosc5CbzNZVrHJ6S3EKrS1yqR`  | n/a                                            |                                    |
| ORE program                | `oreV3EG1i9BEgiAJ8b177Z2S2rMarzak4NMv1kULvWv`  | n/a                                            | read-only; we never call `deploy`  |
| ORE stake program          | `stakecNP3FpiExZPCgZfqRgumVzi6dNqnfrjwXyTgeH`  | n/a                                            | seeds `["stake", user]`            |
| Seeker Genesis Token group | `GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te` | n/a                                            | read-only                          |
| ct_escrow program          | (deployed in M4)                               | (deployed in M4)                               | filled in `CT_ESCROW_PROGRAM_ID_*` |

All eight spec addresses were verified by `tools/scripts/verify-onchain.ts` at M0.

## Payment verification algorithm (M3)

Cash top-up, cosmetic, ad booking, and season-pass purchases all use the same flow. The server credits the ledger only when **all** of the following hold:

1. The transaction succeeded at `confirmed`. Reconcile again at `finalized`.
2. It transfers the expected mint to the treasury account, for at least the intent amount.
3. The memo equals the intentId.
4. The reference key is present.
5. The intent has not expired (`expiresAt > now`).
6. The signature was never credited before. Crediting is idempotent on the signature.

```mermaid
sequenceDiagram
  participant W as Helius webhook
  participant H as Webhook handler
  participant WK as Webhook worker
  participant PG as Postgres
  W->>H: POST /v1/webhooks/helius (signed)
  H->>H: verify HMAC
  H->>WK: enqueue { source, signature, payload }
  H-->>W: 200 OK (immediate)
  WK->>WK: SERIALIZABLE tx
  WK->>PG: SELECT signature FROM payment_intents WHERE signature = ? FOR UPDATE
  WK->>PG: check mint, amount, memo, expiry
  WK->>PG: INSERT ledger_entries (idempotency_ref = signature)
  WK->>PG: UPDATE balances SET cash_cents = cash_cents + ? WHERE user_id = ?
  WK->>PG: UPDATE payment_intents SET status='confirmed', signature=?
  WK-->>RT: city room payment_confirmed
```

A polling reconciler runs every N seconds to pick up webhooks that were missed.

## ORE flows

### Read flow (M3)

The ORE board reader:

- Caches every 2 s.
- Decodes `Board`, `Round`, and `Treasury` accounts from the ORE program.
- Returns `GET /ore/board` with `roundId`, `endsAt`, `endsAtSlot`, `squares[25].deployedLamports`, `motherlodeOre`, `cityStakedOre`, `priceUsd`.
- `GET /ore/me` returns the player's `balance`, `staked`, `stOre`, `minerTier`.
- `minerTier` is derived from the player's ORE balance and the `["stake", user]` PDA. Tiers: `prospector` (any ORE), `miner` (≥ 1 ORE staked), `refiner` (≥ 10 ORE staked).

### Stake flow (M3)

`POST /ore/stake/tx` returns an unsigned v0 transaction for MWA. The action is one of `deposit | withdraw | claim | compound`. The amount is optional and required for deposit/withdraw.

The instruction builders are ported from the Rust `ore-stake-api = "0.3.0"` crate to TypeScript with `@solana/kit`. The porting procedure is:

1. Download the crate source.
2. Derive the discriminators (first 8 bytes of `sha256("global:<name>")`).
3. Derive the account metas per the IDL.
4. Build the instruction with `TransactionInstruction` from `@solana/kit`.
5. Verify the produced instruction bytes by simulating the transaction on mainnet (`simulateTransaction`, no send) against the live stake program.

The ORE-stake TypeScript port lives in `server/shared/solana/ore-stake/` (M3). It has a contract test that round-trips a known instruction against a Rust-built reference.

### Town Crier and ORE NPC

`Town Crier` shouts real motherlode hits on the city room: `"JUST IN: motherlode hit, 55 ORE"`. The ORE reader worker publishes the `event.ore_motherlode` event to Redis pub/sub.

## ORE payments

- ORE top-ups use `TransferChecked` with 11 decimals.
- They go through the same intent checks as USDC, with the ORE mint.
- `bonusBps = 1500` (+15% Cash) is applied at intent creation.

## See also

- `programs/ct_escrow/` — Anchor source (M3+).
- `docs/ECONOMY.md` — the numbers.
- `docs/DECISIONS.md` — version pinning and `ore-stake-api` source reference.
