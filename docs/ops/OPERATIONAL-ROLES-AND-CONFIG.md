# CT Life: Operational Roles, Infrastructure & Configuration

This document specifies the operational ownership, credential management boundaries, and deployment configurations for the CT Life launch.

---

## 1. Operational Ownership Matrix

| Function | Primary Owner | Operational Scope & Access | Key Scripts / Tools |
| :--- | :--- | :--- | :--- |
| **Android Signing & Keystore** | **Iyke** (Dev/Build) & **Joel** (Release/Seeker) | Local SDK and staging builds managed by Iyke. Production `.keystore` and Seeker partner keys held by Joel. | `tools/release/build-android.sh` |
| **Cloudflare Hosting (Pages & R2)** | **Joel** (Admin) & **Iyke** (Deployer) | Cloudflare account under `ctlife.fun`. Pages (`ctlife-play`) and R2 bucket (`ctlife-web`) API access. | `tools/release/deploy-web.sh`, `verify-web-hosting.py` |
| **Contract Admin & Treasury** | **Joel & Iyke** (Multi-sig/Cold Key) | Escrow program (`HiFDmQ2B5KvNAybywbvNhxSnV6empFVvHND2U2oGEb5d`) upgrade authority. Fee treasury signer. | `programs/ct_escrow`, `tools/scripts/escrow-init-config.ts` |
| **Refunds & Dispute Ledger** | **Iyke** (Dispute Officer) | Monitoring `refund_due` entries in `economy_receipts`, investigating disputed transfers, recording refund transactions. | `tools/scripts/manage-refunds.ts` |

---

## 2. Android Build & Signing Configuration

To produce an authentic release build:

* **Staging / Local Testing:** Automatic debug signing is enabled for rapid verification on connected devices.
* **Release / Seeker APK Signing:** Configured via standard environment variables (kept out of git):
  ```bash
  export ANDROID_KEYSTORE_PATH="/path/to/ctlife-release.keystore"
  export ANDROID_KEYSTORE_PASS="<keystore-password>"
  export ANDROID_KEY_ALIAS="<key-alias>"
  export ANDROID_KEY_PASS="<key-password>"
  ```
* **Remote Bundles:** Uses `-ctlifeBundleDelivery remote -ctlifeBundleCdn https://cdn.ctlife.fun` to minimize APK footprint.

---

## 3. Cloudflare Hosting (Web Client)

The web game deployment divides lightweight HTML/assets from heavy content bundles:

* **Pages Project (`ctlife-play`):** Hosts entry point at `https://play.ctlife.fun/`.
* **R2 Bucket (`ctlife-web`):** Content delivery at `https://cdn.ctlife.fun/`.
* **Deployment Automation:**
  ```bash
  # Pre-deployment local validation
  python3 -B tools/release/verify-web-hosting.py "$BUILD_DIR" --local-only

  # Dry-run deployment plan
  tools/release/deploy-web.sh "$BUILD_DIR" --dry-run --cors-file tools/release/cors.json --plan /tmp/upload-plan.tsv

  # Publish release
  tools/release/deploy-web.sh "$BUILD_DIR" --publish --cors-file tools/release/cors.json
  ```
* **Required Cloudflare API Token Scopes:**
  * `Account > Cloudflare Pages > Edit`
  * `Account > Workers R2 Storage > Edit`

---

## 4. On-Chain Contracts & Fee Treasury

* **Escrow Program ID:** `HiFDmQ2B5KvNAybywbvNhxSnV6empFVvHND2U2oGEb5d` (Solana)
* **WIF Token Address:** `0x5173b8ea6923c2d40267890d45c46a3480954773` (Robinhood Chain, `eip155:4663`)
* **NEAR Native Currency:** `near:mainnet` (yoctoNEAR 24 decimals)
* **Treasury Account:** Defined in Railway backend environment as `SOLANA_TREASURY_WALLET`.
* **Secret Protection:** Private keys and mnemonic phrases are strictly excluded from source control and deployment logs.

---

## 5. Refund & Dispute Management Workflow

1. **Detection:** When duplicate, late, or overpaid transfers occur, the backend automatically flags the incoming receipt with `disposition = 'refund_due'`.
2. **Review:** The operator lists pending refund obligations:
   ```bash
   pnpm tsx tools/scripts/manage-refunds.ts list
   ```
3. **Execution & Reconciliation:** Once the refund transfer is executed on-chain from the treasury refund pool, the operator links the transaction:
   ```bash
   pnpm tsx tools/scripts/manage-refunds.ts reconcile <orderId> <refundTransactionHash>
   ```
   The backend verifies the on-chain refund transaction, marks the obligation as `refunded`, and updates the order status.
