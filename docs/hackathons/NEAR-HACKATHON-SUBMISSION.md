# NEAR Hackathon: CT Life — Games With Real Economies

**Event:** NEAR Hackathon  
**Deadline:** November 14, 2026, 23:59 UTC / November 15, 00:59 Lagos  
**Track:** Games With Real Economies  
**Team:** deviykee & Dominion (CT Life Team)  

---

## 1. Project Summary

**CT Life** is a multiplayer 3D virtual world featuring a player-driven on-chain economy. Within the game, players explore a bustling city, purchase properties, furnish apartments, access exclusive venues, trade goods, and participate in micro-jobs.

To enable instantaneous, low-fee microtransactions suitable for high-frequency game interactions, CT Life integrates **native NEAR transfers** (`near:mainnet`) directly into its commerce engine.

---

## 2. In-Game NEAR Economy Integration

Native NEAR powers real in-game economic activities:

* **Merchant & Retail Purchases:** In-game stores, fashion boutiques, and convenience items settle in native NEAR with 24-decimal yoctoNEAR accuracy.
* **Apartment Leases & Utilities:** Players rent flats and homes with automated on-chain lease quotes and payment tracking.
* **Peer-to-Peer Tipping & Services:** In-world services, courier deliveries, and social tips execute directly without intermediary custody.

---

## 3. Technical Architecture

CT Life implements a robust, non-custodial payment verification model:

1. **Unsigned Payment Preparation:**
   * Backend generates exact NEP-141 / native `Transfer` instructions:
   ```json
   {
     "kind": "near",
     "chainId": "near:mainnet",
     "signerId": "player.near",
     "receiverId": "ctlife.near",
     "actions": [
       {
         "type": "Transfer",
         "params": { "deposit": "1000000000000000000000000" }
       }
     ]
   }
   ```
2. **Client Signing & Broadcast:**
   * The player approves and broadcasts the transaction through their connected NEAR wallet (e.g., MyNearWallet, Meteor, HOT).
3. **Finalized Verification & Delivery:**
   * CT Life backend polls the NEAR RPC (`tx` endpoint) waiting for `final_execution_status: "FINAL"`.
   * Verifies the execution block timestamp falls within the order validity window.
   * Uniquely binds the receipt event to prevent replay attacks and delivers game items atomically.

---

## 4. Reproducible Verification

The integration can be verified live using the included test utility:

```bash
# Run the live NEAR mainnet verification test
pnpm tsx tools/scripts/test-near-payment.ts
```

**Verified Capabilities:**
* Connects to NEAR mainnet RPC (`https://free.rpc.fastnear.com` / `https://rpc.mainnet.near.org`).
* Validates `chain_id === "mainnet"`.
* Verifies latest block height and hash.
* Confirms unsigned native `Transfer` action formatting with exact yoctoNEAR deposits.

---

## 5. Submission Checklist & Social Demo

* **Category:** Games With Real Economies
* **Repository Strategy:** Standalone adapter extractable to a public GitHub repository with reproducible test script, preserving private game assets and client engine code.
* **X (Twitter) Demonstration:**
  * Video demonstrating in-game store checkout, NEAR wallet approval, and instant item delivery.
  * Tagging `@NEARProtocol` and `#NEARHackathon`.
