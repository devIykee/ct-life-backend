# Native economy payment evidence

`server/application/economy-chain.ts` prepares unsigned wallet requests and verifies
finalized transfers. It does not sign, broadcast, custody funds, grant inventory,
bridge assets, convert prices, or make the full game economy live. The current
implementation is a foundation for the durable order service. Fixture tests are
not evidence of successful mainnet payments or production wallet compatibility.

| Network                         | Enabled asset                                     | Base-unit decimals |
| ------------------------------- | ------------------------------------------------- | ------------------ |
| Robinhood mainnet `eip155:4663` | WIF `0x5173b8ea6923c2d40267890d45c46a3480954773`  | 18                 |
| NEAR mainnet `near:mainnet`     | Native NEAR                                       | 24                 |
| Solana mainnet `solana:mainnet` | Native SOL                                        | 9                  |
| Solana mainnet `solana:mainnet` | ORE `oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp` | 11                 |

Amounts are canonical positive decimal integer strings, checked against each
chain's integer width. No floating-point price arithmetic is used. Solana payer
and recipient must both be on-curve wallets because refunds reverse their roles.
PDA/escrow senders, token-2022 extensions, general contracts, bridge/router
transactions, delegated payers, NEAR fungible tokens and ETH payments are outside
this adapter's supported transfer semantics.

## Integration contract

Construct `createEconomyChain({ rpc })`, normally using
`createEconomyHttpRpc({ rpcUrls, fetch?, timeoutMs? })`. Endpoints are explicitly
configured per internal chain ID; there are no public endpoint or testnet
fallbacks. The transport permits read methods only, limits response bytes, rejects
redirects, applies a timeout, and redacts provider failures. HTTPS is required
except for loopback test fixtures. RPC operators remain a trust boundary: this
is JSON-RPC verification, not an independent cryptographic light client.

`preparePayment(expectation)` returns one stable tagged request:

- Solana: unsigned legacy `transactionBase64`, payer fee payer, exact transfer,
  memo requiring the payer's signature. ORE includes idempotent recipient ATA creation followed by
  `transferChecked`. Finalized mint owner/initialization/decimals are checked.
- EVM: `{from,to,data,value:'0x0',chainId:'0x1237'}`; direct ERC20 `transfer` only.
  Preparation checks WIF bytecode and `decimals()` on the verified network.
- NEAR: exact `signerId`, `receiverId`, and one `Transfer` action with decimal
  `params.deposit`. The wallet supplies authorization, nonce and fees.

`verifyPayment(expectation, transactionId)` returns `verified`, `pending`, or
`rejected`; provider failures throw a retryable capability error. The expectation
specifies exact parties, asset, amount, reference and inclusive block-time window.
A later poll can verify a transfer executed within that window. NEAR uses the
actual transfer receipt's execution block time, which can follow transaction
inclusion. The verifier requires `FINAL`, successful linked outcomes including
refund receipts, and the canonical finalized block. Solana verifies exact signed
memo, outer/inner transfer instruction, transaction-time token ownership and
balance changes, finalized signature status, and block membership. EVM verifies
the direct call, successful receipt, exact Transfer event and finalized canonical
block. Multiple matching transfers are rejected.

## Replay and recovery boundaries

The order service must atomically claim unique `(chainId,eventId)` before delivery;
event IDs include the transaction ID and log/instruction/receipt identity. A
transaction hash alone is never proof. The Solana memo is the order ID, or
`refund:<orderId>` for reversed refund verification. Standard EVM/NEAR transfers
do not carry that memo: evidence has `reference:null`, so global event uniqueness
and immutable quote matching are essential.

Additional exact-price transfers can become separate refund obligations in the
order service. A single underpayment or overpayment is rejected by this exact
amount adapter and is **not automatically recorded as a refund liability**.
Such transfers require manual investigation until a separately reviewed recovery
adapter exists. No automatic refund signer or outgoing payment worker is present.
Full gameplay adapters, live offers, wallet-device acceptance and production
settlement remain separate work; this module does not assert that they are live.

## Protocol sources

- [Robinhood network identifiers](https://docs.robinhood.com/chain/connecting/)
- [Ethereum JSON-RPC finality, transactions and receipts](https://ethereum.org/en/developers/docs/apis/json-rpc/)
- [ERC20 transfer events and decimals](https://eips.ethereum.org/EIPS/eip-20)
- [NEAR execution statuses, receipts and polling errors](https://docs.near.org/api/rpc/transactions)
- [NEAR canonical block queries](https://docs.near.org/api/rpc/block-chunk)
- [Solana transaction metadata and inner instructions](https://solana.com/docs/rpc/json-structures)
- [Solana finalized transaction queries](https://solana.com/docs/rpc/http/gettransaction)
- [Solana mainnet full genesis identifier](https://solana.com/docs/payments/agentic-payments/x402)
- [Memo signer verification](https://www.solana-program.com/docs/memo)

The existing `@solana/spl-token` version constraint remains `^0.4.15`; it moved
from devDependencies to dependencies because this adapter and existing backend
code import it at runtime. No new token library version was introduced.
