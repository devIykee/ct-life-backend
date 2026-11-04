# Universal economy foundation — first implementation

This is the first implementation slice of CT Life's approved shared economy. It extends the existing player UUID and cosmetic inventory. It does not replace Cash throughout gameplay or certify the game for live funds.

The current implementation covers verified wallet identity, explicitly configured native-asset offers, immutable purchase orders, unsigned payment preparation, finalized receipt verification, one-time wearable delivery and verified refund recording. The Unity client validates requests against the reviewed order and keeps account-scoped recovery state before handing control to a wallet. Existing Solana mainnet wallet integrations supply the first actual signing port; native EVM and NEAR Unity wallet bridges still need implementation and device/browser validation.

## Assets and amounts

| Network identifier | Asset                                             | Decimals | Maximum base units |
| ------------------ | ------------------------------------------------- | -------- | ------------------ |
| `eip155:4663`      | WIF `0x5173b8ea6923c2d40267890d45c46a3480954773`  | 18       | 2^256 - 1          |
| `near:mainnet`     | `native` NEAR                                     | 24       | 2^128 - 1          |
| `solana:mainnet`   | `native` SOL                                      | 9        | 2^64 - 1           |
| `solana:mainnet`   | ORE `oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp` | 11       | 2^64 - 1           |

These are internal network identifiers. In particular `solana:mainnet` is not advertised as a CAIP-2 identifier. Monetary values are canonical positive decimal strings, never JavaScript numbers, floats, Cash balances or cents. Network gas is separate from the purchase asset. There is no implicit exchange rate or balance pooling.

## Identity and orders

See [WALLET-LINKS.md](WALLET-LINKS.md) for the proof contract and limitations. The existing SIWS primary wallet remains the login anchor. A wallet link proves ownership, not a delegated spend authorization. Additional native-wallet login and safe account recovery remain later identity work.

Migration151 creates `economy_offers`, `economy_orders`, `economy_receipts` and `economy_payment_attempts`. Only an explicit active merchant offer is purchasable. No mainnet prices, recipients or arbitrary Cash-to-crypto conversions are seeded. Merchant prices require an intentional asset, recipient, wearable and versioned terms. Purchases of grant-only or NFT-mint-only items are excluded from this adapter.

Creation serializes per player, verifies an active owned wallet link in the same DB transaction, and snapshots the offer's chain, asset, exact amount, payer, recipient, terms and item. A quote lasts fifteen minutes. Reusing its UUID idempotency key with different inputs conflicts, including after the generic Redis cache would expire. A changed catalog price does not change a prior order. Existing ownership and concurrent unpaid orders are checked before quoting.

The current cosmetic adapter writes `source=shop` in existing inventory and records the real-asset provenance separately in `economy_receipts`. It does not grant `source=mint`, NFT mint eligibility or Cash credit.

## Payment, delivery and recovery

1. Fetch a signed-in player's offer and create an order.
2. Prepare its exact unsigned native transfer. The client independently validates asset, payer, recipient, network, amount and permitted instructions before wallet authorization.
3. Persist the intent before opening the wallet. Persist the returned transaction reference before reporting it to the API. Unknown wallet outcomes must be reconciled, not automatically re-signed.
4. The server persists submitted references before RPC verification. Chain verification is outside the database transaction. A transaction hash or wallet callback alone never grants inventory.
5. Finalized evidence is globally claimed by `(chain_id,event_id)`. Receipt insertion and wearable grant commit atomically under the order lock. A delivery failure rolls both back and leaves the attempt recoverable. Concurrent duplicates cannot grant a second inventory row.
6. GET reconciles at most one pending attempt per call, ordered by last check. Rejected references do not permanently block later attempts. Provider failures retain the attempt. RPC-dependent reads are rate-limited separately from writes.
7. The response exposes verified `paymentReceipts`. Match the retained transaction ID in this list before treating it as acknowledged. `200` plus `status=fulfilled` may still describe the original purchase while a second payment is pending.

`fulfilled` means the entitlement was delivered. A timely payment discovered after quote expiry can still deliver; a cancelled quote or a transfer actually executed after expiry becomes `refund_due`. Additional exact-price transfers produce separate refund obligations while the original order remains fulfilled.

The refund route only verifies an already-executed transfer from the snapshotted merchant to the original payer, in the same asset and amount. It consumes one oldest outstanding receipt, rejects a refund that predates its payment, and globally deduplicates that refund event. There is no backend merchant signer or automatic refund sender. Solana direct-transfer parties must be on-curve; future contract escrow requires a distinct adapter.

## Explicit limits of this slice

- Only the existing cosmetic inventory is connected to delivery. Housing, furniture, travel, businesses, jobs, tips, ads, markets and casino retain existing behavior until individually migrated.
- Incoming amount mismatches are rejected by the narrow verifier. Over/underpayments made outside the exact prepared request need merchant investigation; they are not automatically credited or refunded by this API.
- RPC data is trusted through explicit configured providers. Fixture tests are not a mainnet liquidity, provider availability, wallet-device or external security audit.
- There is no bridge, swap, exchange-rate guarantee, automatic payout or shared fungible balance. EVM smart-account/relayer transactions and generalized contract calls require different verification semantics.
- No new money is created by gameplay. Future earnings need an identified funded payer, budget reservation and settled payout; future wagers need actual escrow, outcome verification and recovery. Extending this purchase path does not by itself provide those systems.

## Next implementation sequence

1. Add actual EVM and NEAR wallet signing/login bridges for web and APK, then prove one end-to-end native purchase per supported asset/platform with explicit merchant terms.
2. Migrate each audited spending action to the same quote/receipt/delivery model, beginning with wearables, furniture, housing and services. Add the corresponding fulfillment and refund rules before switching that action's UI.
3. Add funded reward/budget and escrow adapters for jobs, businesses, ownership revenue, marketplace settlement and casino. Keep each source of funds and payout obligation explicit.
4. Add optional cross-chain funding only where a provider demonstrably supports the required asset/route. Native payments do not depend on bridging.

Protocol details and researched primary sources are in [ECONOMY-CHAIN.md](ECONOMY-CHAIN.md). The preceding product audit and incumbent research live in the Unity repository under `docs/research/universal-economy-20261104.md` and `docs/research/multichain-incumbents-20261104.md`.
