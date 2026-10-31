# Street voice (proximity voice on CT Island streets)

Capability **`streetVoice`**, off by default. Until an operator adds it to `CAPABILITIES_ON`,
`POST /v1/rtc/token {kind: "proximity"}` answers `503 CAPABILITY_OFF {capability: streetVoice}`,
the street room writes no voice presence and never calls LiveKit, and `GET /config` sends
`capabilities.features.streetVoice: false` (the client hides the street mic).

Labels: **[Verified]** = read in this repo or in a primary source linked here. **[Inference]** =
reasoning, not tested. **[Unverified]** = not confirmed.

## Rooms

- One LiveKit room per street Colyseus instance: **`proximity:<district>:<instanceId>`**. The street
  room is one instance per district (`filterBy district`, `maxClients = 100`), so voice membership
  equals visibility membership. Venues keep `venue:<instanceId>`.
- Token request: `POST /v1/rtc/token {kind: "proximity", id: "<district>:<instanceId>"}`. `id` may
  carry the `proximity:` prefix. `instanceId` is the street room's `welcome.instanceId`.
- The client hears one place at a time: the street room it stands in, or the venue room once it is
  inside a venue. It joins the new LiveKit room before it leaves the old one where it can (see
  District edges for the one case where it cannot).

## Presence and the token check

- `server/realtime/street-presence.ts`: a Redis hash **`ctl:street:members:<district>:<instanceId>`**,
  one field per user holding that user's open session count (a copy of the venue presence from
  PR #40). `StreetRoom.onJoin` adds 1 **before** `welcome`, `onLeave` takes 1, `onDispose` deletes the
  hash, and a live room refreshes the 24 h expiry hourly. The district is in the key, so an instance
  paired with the wrong district finds nothing.
- `server/application/street-voice.ts`, `assertInStreetInstance`: a count above 0 or **`403 NOT_IN_AREA`**
  (`details: {district, instanceId}`). Fails closed; a Redis error mints nothing.
- Malformed ids (unknown district, no instance, an instance with `:` or other characters outside
  `[A-Za-z0-9_-]`) are `400 VALIDATION_FAILED {reason: invalid_room_id}`.
- **Revocation.** LiveKit checks a token only on connect and hands connected participants refreshed
  tokens itself, so a short TTL alone never disconnects anyone, and a removed participant could come
  back with a token it still holds. Four layers:
  1. The street room calls LiveKit `removeParticipant` on `proximity:<district>:<instanceId>` when a
     user's **last** session leaves. Bans close sessions with `client.leave(4003)`, so a kick leaves
     voice too.
  2. Street tokens last **2 minutes**, so a token copied out of the client is soon useless for a new
     connection. The client asks for a fresh token on every join and reconnect.
  3. Every `participant_joined` webhook on a `proximity:` room is checked again
     (`checkStreetVoiceJoin`). A participant who is not in that street instance, or is out of minutes,
     is removed at once. This catches a reconnect with a kept or LiveKit-refreshed token.
  4. Once a minute each street room sweeps everyone the webhook says is connected to its voice room,
     members or not (`streetVoiceRemovals`), so a removal that failed on leave is retried.
- Grants: `canPublish: true`, `canSubscribe: true`. The client joins listen-only and publishes only
  from the mic gesture.

## District edges: no cross-district voice (decision)

Two players a few metres apart on either side of a district line are in different street rooms.
**They neither see nor hear each other.** The server never mints a token for an instance the caller
is not in, including the neighbouring district's.

Why:

1. Voice follows visibility. The client joins one street room at a time (the district it stands in),
   so it has no avatar, and no position, for a player across the line. A voice it cannot place would
   play from nowhere, and the mute, block and report actions all hang off the avatar.
2. Security. The alternative in PHASE2-STREET.md §2.2 item 3 (a listen-only token for a neighbouring
   instance, based on a fresh `ctl:pos` within 18 m of the polygon) gives a token for a room the caller
   is not a member of. Removal on leave would then also have to track a second room. [Inference]
3. Cost. A second room near every border doubles connected minutes there. [Inference]

Crossing the line: the Unity client's street slot leaves the old district's street room and then
joins the new one (`RoomJoinSlot`, break-before-make). The old room's leave removes the player from
the old LiveKit room, and the client connects to the new one after the new `welcome`. So a district
crossing has a short gap in street voice, about one join plus one LiveKit connect [Inference: not
measured]. Walking into or out of a venue has no gap: the street room stays joined while the player
is inside a venue, so the client connects the new voice room first and then drops the old one.

Revisit when the client shows players across the line (two street rooms at once). The token rule
would then be "a member of each instance you hold", with no change to this check.

## Minutes and cost

### What prod uses (from the env docs only)

- `.env.example`: "Staging/prod: LiveKit Cloud". `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
  are plain env vars, so moving to a self-hosted server is a config change. [Verified in this repo]
- `docs/RAILWAY.md` lists "LiveKit: $50/mo (Build)". On LiveKit's pricing page (2026-11-01), **Build is
  $0** with 5,000 minutes and **$50/month is Ship** with 150,000 minutes. So the repo docs disagree
  with themselves, and **which plan prod is on is [Unverified]**. These defaults assume the free plan.

### LiveKit Cloud limits [Verified 2026-11-01]

| Plan  | Price             | WebRTC participant-minutes | Concurrent | Downstream | Over the allowance                                    |
| ----- | ----------------- | -------------------------- | ---------- | ---------- | ----------------------------------------------------- |
| Build | $0                | 5,000 / month              | 100        | 50 GB      | **hard cap: "new requests fail after it's exceeded"** |
| Ship  | from $50 / month  | 150,000 / month            | 1,000      | 250 GB     | $0.0005 / min                                         |
| Scale | from $500 / month | 1.5M / month               | 5,000      | 3 TB       | $0.0004 / min                                         |

Sources: https://livekit.com/pricing , https://docs.livekit.io/home/cloud/quotas-and-limits/ .
A participant-minute is "time that a single user is connected to LiveKit Cloud via a LiveKit SDK",
so **listen-only connections count**. The allowance resets on the first of each calendar month and
is shared with venue voice, Spaces and calls. On Build, running out breaks paid calls too.

### Estimate [Inference]

The client joins the street room listen-only whenever `streetVoice` is on and the player is on a
street, so street voice minutes ≈ minutes spent on streets.

- 20 daily players × 20 street minutes × 30 days = **12,000 participant-minutes a month**, 2.4 times
  the whole free allowance, from street voice alone.
- The free allowance is about 161 minutes a day for everything (5,000 / 31).

### Caps (this PR)

| Env                                     | Default | Meaning                                                                |
| --------------------------------------- | ------- | ---------------------------------------------------------------------- |
| `STREET_VOICE_DAILY_MINUTES_PER_PLAYER` | 20      | Street voice minutes per player per UTC day. 0 = no cap.               |
| `STREET_VOICE_DAILY_MINUTES_TOTAL`      | 100     | Street voice minutes for the whole deployment per UTC day. 0 = no cap. |

With the defaults, street voice uses at most about 100 × 31 = 3,100 minutes a month (plus the open
sessions running when the total is reached), which leaves about 1,900 of the free 5,000 for venue
voice, Spaces and calls. On Ship, or on a self-hosted server, raise them or set both to 0.

How they work:

- Counting comes from the **LiveKit webhook** (`POST /v1/webhooks/livekit`, the one paid calls already
  rely on). `participant_joined` on a `proximity:` room opens a session in the hash
  `ctl:voice:street:sessions`, **keyed by the LiveKit participant SID** (value `start|user|room`). Only a
  `participant_left` with the same SID (and identity) closes it, adding its seconds to
  `ctl:voice:street:sec:<UTC day>:u:<userId>` and `…:total` (kept two days). So a reconnect whose new
  participant joins before the old one leaves keeps both sessions apart. A leave that matches no session
  keeps every entry and leaves a one-day marker, so a late (out-of-order) join for that SID opens nothing.
- The event-id claim (`ctl:voice:street:evt:<id>`, a day; LiveKit retries) and the session and counter
  writes run in **one Lua script**, so an event never counts twice, and an event that fails before the
  script runs is counted on LiveKit's retry.
- An open session counts at most 2 h, and sessions older than 6 h are dropped, so a lost
  `participant_left` cannot lock a player out for long.
- `POST /v1/rtc/token {kind: proximity}` refuses with **`429 VOICE_MINUTES_EXHAUSTED`**
  `{scope: player | total, capMinutes, resetsAt}` when either cap is used up. **Both checks count open
  sessions**, the caller's own for the player cap and everyone's for the total.
- A reconnect past a cap is removed by the join check (layer 3 above). Once a minute each street room
  removes everyone connected to its voice room who is past the per-player cap, and everyone connected
  once the deployment's total is used up (open sessions included).
- **[Unverified] that the LiveKit Cloud project has its webhook pointed at the backend.** Without the
  webhook nothing is counted and the caps never trigger. Check the LiveKit Cloud project settings
  before turning `streetVoice` on.

### The bigger levers (not in this PR)

1. **Lazy connect** (PHASE2-STREET.md §2.3): a `micOn` flag on the street player schema, so the client
   joins the voice room only when an open mic is within 20 m. Quiet streets then cost nothing.
2. **Self-host LiveKit** (PHASE2-STREET.md §3, Oracle Always Free Arm VM). Then set both caps to 0.

## Not in this PR

- Server-enforced distance. A connected client can subscribe to every mic in its street room (up to
  100 players). Fixes: publisher-side `SetTrackSubscriptionPermissions` (DESIGN step 1.4) or
  server-driven `UpdateSubscriptions`.
- Lazy connect, self-hosting (above).

## Operator checklist

1. Confirm the LiveKit plan in the LiveKit Cloud dashboard, and that its webhook URL is
   `https://<api host>/v1/webhooks/livekit`.
2. Pick the caps for that plan (`STREET_VOICE_DAILY_MINUTES_PER_PLAYER`, `STREET_VOICE_DAILY_MINUTES_TOTAL`).
3. Deploy, then add `streetVoice` to `CAPABILITIES_ON` on the api **and** realtime services (the
   realtime street room reads it when each room opens).
