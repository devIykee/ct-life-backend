# Home NFT gallery (unlock D4)

Players frame NFTs they really hold on their home's walls, for visitors to see. **Read-only**: the
server reads holdings and never mints, transfers or signs anything here. Capability `nftGallery`.
Contract: `contract/openapi.yaml` (`/nfts/me`, `/homes/{ownerId}/gallery`, `/homes/me/gallery`,
`/img/{hash}`, config `nft`). Tuning: `contract/config/nft_gallery.json`.

## Holdings (Helius DAS)

- `getAssetsByOwner {ownerAddress, page: 1, limit: 1000}` per network, on
  `HELIUS_RPC_URL_DEVNET` / `HELIUS_RPC_URL_MAINNET` (with `api-key` added from `HELIUS_API_KEY` when the
  URL has none). Documented at https://www.helius.dev/docs/api-reference/das/getassetsbyowner (limit up to
  1000, page-based). One call per network per wallet, cached 10 min in Redis.
- Devnet: every NFT the wallet holds. `moderation: ok` only for `devnetCollections`, otherwise
  `pending` (the owner sees it, visitors do not).
- Mainnet: read-only and only `mainnetCollections`; everything else is dropped. DAS has no NSFW flag,
  so nothing outside a list is shown to visitors.
- Interfaces kept: `V1_NFT`, `V2_NFT`, `LEGACY_NFT`, `ProgrammableNFT`, `MplCoreAsset`, `MplCore`
  ([Unverified] which of the last two real Core responses use: Helius's enum says `MplCoreAsset`,
  Metaplex's fetch page shows `MplCore`; both are accepted). Burnt assets and fungibles are dropped.
- With `showUnverifiedCollections` left off (the default), DAS skips unverified collection groupings,
  so a `collection` value is a verified one (Helius getAsset docs).
- Free plan limits (https://www.helius.dev/pricing, read 2026-10-30): 1M credits a month, DAS 2
  requests/s, 10 credits per DAS call. Every DAS call takes a slot from a Redis per-second budget
  shared by all processes (`dasRequestsPerSecond`); a caller waits up to ~12 s, then gets
  `429 RATE_LIMITED {reason: das_busy}`. A Helius failure is `503 SERVER_BUSY {reason: das_unavailable}`.

## Allow-lists

`mainnetCollections` ships with one entry, Mad Lads `J1S9H3QjnRtBbbuD4HjPV6RpRhwuk4zKbxsnCHuTgh9w`,
taken from the `group_value` in Helius's own getAsset example. [Inference] It is the real collection;
it was not confirmed on a project page. Add others only after reading one known asset's
`grouping[0].group_value` with `getAsset`.

`devnetCollections` is empty until the CT Life devnet collection exists (see "Not in this PR").

## Images

`imageUrl` is always the API's own proxy, `<PUBLIC_API_BASE_URL>/v1/img/<hash>`, and config `nft.imageHosts`
lists that host (empty when `PUBLIC_API_BASE_URL` is unset, which the Factory also needs). The proxy
(`server/application/nft-images.ts`):

- fetches only URLs the server itself read from DAS (the hash is registered when holdings are read);
- uses Helius `cdn_uri` first, then `links.image`, then `files[0].uri`; `ipfs://` and `ar://` go
  through `ipfs.io` and `arweave.net`;
- https only and **no IP-literal hosts** (`https://[::1]/`, `https://10.0.0.1/`): Node skips a custom
  DNS lookup for literals, so they are refused outright (security review M1);
- every resolved address must be public: loopback, private, link-local, CGNAT, ULA, site-local, NAT64
  (`64:ff9b::/96`), 6to4 (`2002::/16`), IPv4-compatible (`::/96`), IPv4-mapped (`::ffff:0:0/96`),
  documentation and multicast are refused; the connection is pinned to the checked address, and the
  socket's real peer address is checked again on connect (DNS-rebinding safe);
- at most 3 redirects, each checked the same way; **one 10 s deadline for the whole fetch**, so a source
  trickling a byte at a time cannot hold a socket (L6); at most 4 fetches at once per process;
- PNG, JPEG, GIF, WebP or AVIF only (no SVG), at most 8 MiB, at most 40 MP decoded;
- no new fetch once the cache holds `maxStoredImageBytes` (1 GiB); new image URLs of non-allow-listed NFTs
  (which anyone can mint) count against `maxNewImagesPerWalletPerDay` (200) per wallet, so one wallet cannot
  grow the cache without bound (L6);
- re-encodes to a palette PNG no larger than 512 px and 512 KiB (stepping down to 384 and 256 px if
  needed), and caches it in `nft_images`. A failed source is retried after an hour.

## Wall

- Per player, up to 12 slots (`maxSlots`), one asset per slot. The asset's name, collection, image and
  moderation are copied when framed, so a visitor costs no DAS call.
- A visitor needs the same access as a visit: the visitor policy (`BLOCKED`, `HOME_CLOSED`,
  `followers_only`) and then the door (`FORBIDDEN {reason: locked}`), and sees only `ok` frames.
- Daily at 04:30 UTC the workers re-check ownership with `getAssetBatch` (up to 1000 ids per call) and
  remove frames whose asset is burnt or no longer in the wallet.

## Not in this PR

The plan also asks for a CT Life devnet Metaplex Core collection whose prints are sold through
`POST /payments/intents {kind: 'cosmetic', sku}` and minted on confirm. That part is left out on purpose:

- the settlement branch lives in `server/api/routes/payments.ts` / `server/application/topup.ts`, which
  WP-C owns and is changing in C1 (season pass);
- minting needs a funded devnet ops treasury (Phase 0, Q6), and creating the collection is a one-time
  on-chain step;
- `@metaplex-foundation/mpl-core` is not a dependency yet (latest 1.10.0, published 2026-04-16, per the
  npm registry).

Once the collection exists, add its address to `devnetCollections` and its prints show as `ok`.

## Policy flag

Google Play's blockchain content policy needs a Financial features declaration if users can earn
tokenized assets (https://support.google.com/googleplay/android-developer/answer/13607354). The gallery only
displays what a wallet already holds; nothing is earned or minted here.
