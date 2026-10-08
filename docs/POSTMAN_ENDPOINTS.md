# CT Life Backend - API Endpoints for Postman Testing

## Server Setup

**Base URL**: `http://localhost:3000` (or check your PORT_API env var)

**To Start Server**:
```bash
cd /home/iyke/coding/ct-life-backend
tsx server/api/main.ts
# OR if there's a dev script:
pnpm --filter api dev
```

---

## Authentication Flow

### 1. Request Nonce
```
POST /v1/auth/nonce
Content-Type: application/json

{
  "wallet": "YOUR_SOLANA_WALLET_ADDRESS"
}

Response:
{
  "nonce": "abc123xyz789"
}
```

### 2. Verify & Sign In
```
POST /v1/auth/verify
Content-Type: application/json
Idempotency-Key: {{$guid}}

{
  "message": "SIWS_MESSAGE_SIGNED_BY_WALLET",
  "signedMessage": "BASE64_ENCODED_SIGNATURE",
  "wallet": "YOUR_SOLANA_WALLET_ADDRESS"
}

Response:
{
  "accessToken": "eyJ...",
  "refreshToken": "eyJ..."
}
```

### 3. Refresh Token
```
POST /v1/auth/refresh
Content-Type: application/json

{
  "refreshToken": "YOUR_REFRESH_TOKEN"
}
```

**Note**: For all authenticated endpoints below, add this header:
```
Authorization: Bearer YOUR_ACCESS_TOKEN
```

---

## Core Endpoints

### Get Configuration
```
GET /v1/config

Response: All game configuration (tribes, dreams, traits, items, venues, etc.)
```

### Get Current User
```
GET /v1/me
Authorization: Bearer {{accessToken}}

Response: User profile, character, needs, skills, balance
```

### Roll Lottery (First-time only)
```
POST /v1/lottery/roll
Authorization: Bearer {{accessToken}}
Idempotency-Key: {{$guid}}

Response:
{
  "outcomeId": "home_id",
  "cashCents": 50000
}
```

### Create Character
```
POST /v1/characters
Authorization: Bearer {{accessToken}}
Idempotency-Key: {{$guid}}
Content-Type: application/json

{
  "alias": "YourCharacterName",
  "ageConfirmed": true,
  "tribeId": "tribe_id_from_config",
  "dreamId": "dream_id_from_config",
  "traitIds": ["trait1", "trait2"],
  "look": {
    "skinTone": "skin_tone1",
    "headId": "head_item_id",
    "hairId": "hair_item_id",
    "topId": "top_item_id",
    "bottomId": "bottom_item_id",
    "shoesId": "shoes_item_id",
    "accId": "acc_item_id"
  }
}
```

### Get User Profile
```
GET /v1/users/:userId
```

---

## Work & Shifts

### Start Shift
```
POST /v1/shifts/start
Authorization: Bearer {{accessToken}}
Idempotency-Key: {{$guid}}
Content-Type: application/json

{
  "venueId": "venue_id_from_config"
}

Response:
{
  "shiftId": "uuid",
  "startedAt": "2026-01-19T...",
  "venueId": "..."
}
```

### Complete Shift
```
POST /v1/shifts/:shiftId/complete
Authorization: Bearer {{accessToken}}
Idempotency-Key: {{$guid}}
Content-Type: application/json

{
  "scores": {
    "mini_game_1": 85,
    "mini_game_2": 92
  }
}

Response:
{
  "payCents": 1500,
  "xp": 50,
  "promoted": false
}
```

---

## Needs Actions

### Apply Needs Action
```
POST /v1/needs/actions
Authorization: Bearer {{accessToken}}
Idempotency-Key: {{$guid}}
Content-Type: application/json

{
  "actionId": "eat" // or "sleep", "shower", "touch_grass", "party"
}

Response:
{
  "needs": {
    "energy": 75,
    "hunger": 80,
    "fun": 50,
    "hygiene": 60,
    "sanity": 70
  },
  "cashCents": 48500
}
```

---

## Social Features

### Block User
```
POST /v1/blocks/:userId
Authorization: Bearer {{accessToken}}
Idempotency-Key: {{$guid}}

Response: 201 Created
```

### Unblock User
```
DELETE /v1/blocks/:userId
Authorization: Bearer {{accessToken}}

Response: 204 No Content
```

### Send Friend Request
```
POST /v1/friends/:userId/request
Authorization: Bearer {{accessToken}}
Idempotency-Key: {{$guid}}
```

### Accept Friend Request
```
POST /v1/friends/:userId/accept
Authorization: Bearer {{accessToken}}
Idempotency-Key: {{$guid}}
```

### Send Direct Message
```
POST /v1/dms
Authorization: Bearer {{accessToken}}
Idempotency-Key: {{$guid}}
Content-Type: application/json

{
  "toUserId": "recipient_user_id",
  "text": "Hello!"
}
```

---

## Payments

### Create Payment Intent
```
POST /v1/payments/intents
Authorization: Bearer {{accessToken}}
Idempotency-Key: {{$guid}}
Content-Type: application/json

{
  "cashCents": 10000,
  "currency": "USDC", // or "SOL", "SKR", "ORE"
  "bonusBps": 0
}

Response:
{
  "intentId": "uuid",
  "memo": "memo_string_for_blockchain",
  "address": "treasury_address",
  "amount": "amount_in_base_units",
  "currency": "USDC",
  "expiresAt": "2026-01-19T..."
}
```

### Verify Payment
```
POST /v1/payments/verify
Authorization: Bearer {{accessToken}}
Idempotency-Key: {{$guid}}
Content-Type: application/json

{
  "intentId": "payment_intent_id",
  "signature": "blockchain_transaction_signature"
}
```

---

## Voice/Video

### Start Voice Space
```
POST /v1/spaces
Authorization: Bearer {{accessToken}}
Idempotency-Key: {{$guid}}
Content-Type: application/json

{
  "title": "My Space",
  "description": "Discussion topic"
}

Response:
{
  "spaceId": "uuid",
  "roomId": "livekit_room_id",
  "token": "livekit_token"
}
```

### Start Video Call
```
POST /v1/video-calls
Authorization: Bearer {{accessToken}}
Idempotency-Key: {{$guid}}
Content-Type: application/json

{
  "userIds": ["user1", "user2"]
}

Response:
{
  "callId": "uuid"
}
```

### Get RTC Token (Participant)
```
POST /v1/rtc/token
Authorization: Bearer {{accessToken}}
Idempotency-Key: {{$guid}}
Content-Type: application/json

{
  "roomId": "livekit_room_id",
  "kind": "video" // or "call", "space", "venue", "proximity", "paid_call"
}

Response:
{
  "token": "livekit_participant_token",
  "roomId": "...",
  "kind": "video"
}
```

---

## Admin Endpoints

**Note**: Requires admin wallet in config.auth.adminWallets

### Get Ratio Arena Stats
```
GET /v1/admin/ratio-arena/stats
Authorization: Bearer {{adminAccessToken}}
```

### Trigger Airdrop
```
POST /v1/admin/airdrop/trigger
Authorization: Bearer {{adminAccessToken}}
Idempotency-Key: {{$guid}}
```

---

## Testing Tips

### Postman Environment Variables

Create a Postman environment with:
```
baseUrl: http://localhost:3000
accessToken: (set after login)
refreshToken: (set after login)
userId: (set after login)
wallet: YOUR_WALLET_ADDRESS
```

### Common Headers

**All POST/PUT/PATCH/DELETE**:
```
Idempotency-Key: {{$guid}}
Content-Type: application/json
```

**Authenticated**:
```
Authorization: Bearer {{accessToken}}
```

### Error Responses

All errors follow this format:
```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable message",
    "details": {}
  }
}
```

Common error codes:
- `UNAUTHORIZED` (401)
- `FORBIDDEN` (403)
- `NOT_FOUND` (404)
- `CONFLICT` (409)
- `VALIDATION_FAILED` (400)
- `RATE_LIMITED` (429)
- `IN_FLIGHT` (409) - idempotency key in use

### Rate Limiting

- **Write operations**: 20 requests/second per user
- Returns 429 with `Retry-After` header when exceeded

---

## P1 Security Features to Test

### 1. SIWS Authentication (B6-B8)
- Nonce must be alphanumeric (no hyphens)
- Nonce expires after 10 minutes
- SignedMessage must be base64 encoded
- Message validation includes domain, URI, nonce

### 2. Idempotency (B31)
- Concurrent requests with same key return 409 IN_FLIGHT
- Completed requests replay cached response

### 3. RTC Token Security (B3, B23)
- Video call host doesn't get all participant tokens
- Each participant fetches own token via POST /rtc/token
- Token validation checks user is participant

### 4. Shift Validation (B2, B4)
- Cannot complete same shift twice (409 CONFLICT)
- Can only score assigned mini-games

### 5. Payment Verification (B32)
- Webhook verifies recipient address
- Validates base-unit amount matches intent

### 6. Rate Limiting (F12)
- Try 25 writes in quick succession
- Should get 429 RATE_LIMITED after 20

---

## Quick Start Testing Sequence

1. **GET** `/v1/config` - Get game configuration
2. **POST** `/v1/auth/nonce` - Get nonce for your wallet
3. Sign the SIWS message with your wallet
4. **POST** `/v1/auth/verify` - Exchange signature for tokens
5. **GET** `/v1/me` - Check if you have a character
6. **POST** `/v1/lottery/roll` - Roll lottery (if needed)
7. **POST** `/v1/characters` - Create character (if needed)
8. **POST** `/v1/shifts/start` - Start a work shift
9. **POST** `/v1/needs/actions` - Apply a needs action
10. **POST** `/v1/shifts/:shiftId/complete` - Complete shift

---

**Documentation**: See `docs/handoff/STATUS.md` for P1 implementation details
**Last Updated**: 2026-01-19
