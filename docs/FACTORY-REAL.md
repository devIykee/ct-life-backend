# Rugpull Factory: real token launches (Meteora DBC)

> User decision 2026-10-26: the Factory launches **real Solana tokens** on Meteora's Dynamic Bonding
> Curve, real only (the Cash sandbox is retired). Guardrails: a risk warning on every launch and an
> 18+ gate; no region block (the user's call). Migration 104. Research:
> `ct-life-evidence/factory-r5/REAL-LAUNCH-RESEARCH.md`; Phase 0 spike:
> `ct-life-evidence/factory-r5/mwa-spike/SPIKE-RESULT.md`.

[Inference] = judgement. [Unverified] = not checked.

## How it works

- CT Life is a DBC **partner**: one on-chain config (curve, fees, graduation, LP split, fee claimer)
  that every player launch uses. Players are the **creator**: their wallet pays and signs. The server
  never holds a funded key; the only server-side signer is each launch's fresh **mint** keypair,
  which the DBC program requires as a signer (it creates the mint).
- SDK `@meteora-ag/dynamic-bonding-curve-sdk` **2.0.0** (npm, published 2026-10-15), program
  `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` (devnet and mainnet).
- Default config (`tools/factory/create-dbc-config.ts`): SOL quote; SPL token, 6 decimals, 1B
  supply, immutable metadata; **1% trading fee** (Meteora takes 20% of it, the other 80% is split
  **50/50 partner/creator**); **pool creation fee 0**; graduation to DAMM v2 (fixed 1% fee there);
  after graduation **all LP permanently locked** (50% partner, 50% creator); initial market cap 25
  SOL, graduation 400 SOL (flags). Fees go to `PARTNER_FEE_WALLET` (the config's fee claimer).

## Setup (Iyke / the user)

1. Pick the fee wallet (a multisig recommended) and set `PARTNER_FEE_WALLET` to its **public** address.
2. Create the config once per cluster, with any funded throwaway payer (never a key we keep):
   `pnpm exec tsx tools/factory/create-dbc-config.ts --rpc <RPC> --payer ./payer.json
--fee-claimer $PARTNER_FEE_WALLET` (add `--dry-run` to print the parameters). Put the printed
   `FACTORY_DBC_CONFIG` in the API env. The cluster follows `APP_ENV` (prod = mainnet, otherwise
   devnet) and the RPC is `HELIUS_RPC_URL_*`.
3. Metadata: `FACTORY_METADATA_STORE=pinata` with `PINATA_JWT` + `PINATA_GATEWAY` (permanent IPFS,
   use on mainnet), or `self` with `PUBLIC_API_BASE_URL` (served by `GET /v1/factory/metadata/:id`;
   fine on devnet, but the art disappears with the server).
4. Helius: create a **raw** webhook (`rawDevnet` on devnet) pointing at
   `https://<api>/v1/webhooks/helius/factory` with an auth header; set `HELIUS_FACTORY_WEBHOOK_ID`
   and `HELIUS_FACTORY_WEBHOOK_AUTH` (the exact Authorization value). The API adds each new creator
   wallet and pool to it. [Unverified] the update path (`GET` + `PUT /v0/webhooks/{id}`) and that
   Helius sends `authHeader` as `Authorization`: check once with a real webhook.

Without `FACTORY_DBC_CONFIG` or a metadata store, launches answer `503 FACTORY_UNAVAILABLE` and
`GET /v1/factory/config` says `enabled: false`.

## Turning it on (unlock C3)

The client opens the Launchpad Tower desk only when `GET /v1/config` has
`factory: {livePhase: 2, cluster: "devnet"}`. The API sends it only while **all** of these hold:
the `factory` capability is in `CAPABILITIES_ON`, the cluster is devnet, `FACTORY_DBC_CONFIG` is
set and a metadata store is configured. `POST /v1/factory/launch/prepare`, `/confirm` and
`/submit` answer `503 CAPABILITY_OFF` until the capability is on (`JAILED` is still answered
first); the board, token detail, trades, metadata and the Helius webhook stay open.

Order: run the devnet setup above and `tools/factory/devnet-run.ts` against a local API started
with `CAPABILITIES_ON=factory` (the run needs launches on), keep the report as evidence, set the
env on Railway, then add `factory` to the deployed `CAPABILITIES_ON`.

## Contract for the client (lane C)

1. `GET /v1/factory/config` → `{enabled, cluster, onChain {feeClaimer, creatorTradingFeePercentage,
poolCreationFeeLamports, migrationQuoteThresholdLamports, ...}, riskWarning {version, text},
ageGate: 18, limits, estimatedCostSol}`. Show `riskWarning.text` on every launch screen.
2. `POST /v1/factory/launch/prepare {name, ticker, description?, imageBase64, riskAccepted: true}` →
   201 `{launchId, txBase64, mint, pool, cluster, lastValidBlockHeight, expiresAt, metadataUri,
imageUri}`. Call it **right before** opening the wallet (the blockhash lives about 60-90 s).
   Errors: `AGE_REQUIRED`, `JAILED`, `RISK_NOT_ACCEPTED`, `NAME_NOT_ALLOWED`, `TICKER_TAKEN`,
   `LAUNCH_LIMIT_REACHED` (3 per 24 h), `RATE_LIMITED`, `FACTORY_UNAVAILABLE`. Body up to 4 MB
   (image at most 2 MB before base64).
3. **Main path:** MWA `sign_and_send_transactions([txBytes])` with the **exact decoded bytes**,
   options `{commitment: "confirmed"}`, then `POST /v1/factory/launch/confirm {launchId, signature}`
   → the `FactoryToken`. `409 LAUNCH_NOT_CONFIRMED` (`reason: not_found_yet`) = retry in a second
   or two; `reason: failed_on_chain` = show the error and prepare again.
4. **Fallback:** if sending fails with a signature-verification error (the wallet rewrote the tx and
   broke the mint signature) and `get_capabilities` lists `solana:signTransactions`: call
   `sign_transactions([txBytes])` and `POST /v1/factory/launch/submit {launchId, signedTxBase64}` →
   `{signature, status: submitted | confirmed, token}`. The server only co-signs the same launch
   (`422 LAUNCH_TX_MISMATCH` otherwise). `409 LAUNCH_EXPIRED` → prepare again.
5. Board and detail: `GET /v1/factory/tokens?view=new|trending|mine`, `GET /v1/factory/tokens/:mint`
   (`priceSol`, `marketCapSol`, `progressBps` 0..10000 to graduation, `migrated`, `rugged`,
   `volume24hSol`, `trades24h`; refreshed from the pool at most every 15 s), and
   `GET /v1/factory/tokens/:mint/trades` for the chart. `GET /v1/factory/launch/:launchId` = status.
6. City: confirmed launches broadcast `evt_coin_launch` with `params.real = "1"` and `coinId` = the
   mint. When the Timeline PR (#32) lands, a launch card is posted too (one line in `confirmLaunch`).

### Unity: keep the bytes intact (must check)

`MwaWallet.SignAndSendBase64` deserializes the base64 into Solana.Unity's `VersionedTransaction` and
the SDK re-serializes it with `Transaction.Serialize()`, which **recompiles the message**
(`CompileMessage()` in Solana.Unity-Core). If that changes a single byte (account order, header),
the mint's signature no longer matches and the launch fails.

- **EditMode test (required):** load `ct-life-evidence/factory-r5/mwa-spike/fixture-partially-signed-tx.json`,
  decode `txBase64`, `VersionedTransaction.Deserialize(bytes)`, then `Serialize()`, and assert the
  result equals the original bytes. [Unverified] whether it does.
- **Safer path either way:** hand the original `byte[]` to the low-level MWA client
  (`client.SignAndSendTransactions(List<byte[]>)`, which the SDK's own wrapper calls after
  serializing) instead of a `Transaction` object.
- A Seeker devnet launch with Seed Vault Wallet is still owed (see the spike result).

## Verified so far

- `tools/factory/e2e-local.ts` against the real DBC program (a local validator with the program and
  Metaplex metadata cloned from devnet, 2026-10-26): the config script created our config; path A
  (wallet signs the exact bytes) and path C (wallet rewrites the priority fee, server signs last)
  both launched and confirmed; the token read back at 25 SOL market cap (the config's start); a real
  creator buy + 90% dump, fed to the webhook processor in the RPC's JSON shape, indexed 2 trades and
  flagged the token `rugged`.
- [Unverified] devnet proper (the public faucet refused airdrops all day), mainnet, a Seeker wallet,
  and that Helius raw deliveries match the RPC JSON shape exactly.

- `tools/factory/devnet-run.ts` drives the same flow **through the HTTP API** (dev sign-in,
  prepare → sign → send → confirm, the submit fallback, a creator buy + dump replayed to the webhook
  → heat) and writes a report with explorer links. Rehearsed on the local cluster (heat 0 → 48,
  token rugged); the devnet run waits on devnet SOL (faucet rate-limited, see
  `ct-life-evidence/factory-r5/DEVNET-RUN.md`). Lane C's Seeker kit (byte-preservation EditMode test
  and a device probe): `ct-life-evidence/factory-r5/mwa-spike/lane-c/`.

## Rug detection (penalties only)

The Helius raw webhook delivers every transaction touching a creator wallet or one of our pools.
For each of our mints:

- A signer whose balance of the mint changed is a **trade** (`buy`/`sell`, SOL moved), indexed for
  the chart and 24 h volume.
- The **creator wallet** losing tokens with SOL coming back is a **sell**: heat
  `35 + 15 x share sold`; selling **30% or more** of what they held flags the token `rugged` and
  writes one exposé post (`kind: "sleuth"`, author = the existing NPC id; display names come from
  the client's names table, so the "Sleuth" → "Police" rename needs no server change). Losing tokens
  with no SOL back is a **transfer out**: +10 heat, no post.
- Never a reward. [Inference] Blind spot: a dev who moves tokens to a fresh wallet first only shows
  as a transfer out.

## Retired Cash Factory

- `POST /v1/factory/coins` → `410 FACTORY_CASH_RETIRED`.
- Buying a Cash player coin (`POST /v1/market/trades`, `side: buy`) → `410 FACTORY_CASH_RETIRED`.
  Selling an old position still works, so nobody's Cash is stuck.
- `GET /v1/factory/coins`, `/coins/:coinId` and `/me` stay readable (history).

## Launch allowance in the config (client contract gaps 2)

`GET /v1/factory/config` also returns `launchesLeftToday`: `limits.dailyLaunches` (3) minus the
caller's launches in the last 24 hours (rolling, the same window `LAUNCH_LIMIT_REACHED` uses, not a UTC
day). `limits` is now spelled out in the contract: `{nameMax, tickerMax, descriptionMax, imageMaxBytes,
dailyLaunches}`. The client can disable the launch button at 0 instead of learning it from a `429`.
