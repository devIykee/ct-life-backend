# Credential-scoped media access

New `/rtc/token` grants use `ct1:<player UUID>:<login identity UUID>:<credential version>`. UUIDs are canonical lowercase, nonzero UUID strings. Version is canonical decimal in 0..2147483647. The raw identity is a transport resource key; avatar, profile, mute and membership state use the player UUID. No wallet address or bearer credential is placed in the identity.

Issuance resolves the durable login credential and holds the same user-row lock as credential removal. Migration 155 records the room/identity grant before the token is returned. The grant registry deliberately survives account deletion: previously issued credentials still require cutoff. Login credentials, payment-wallet links and media grants remain separate.

## Enforcement

Initial tokens last at most 600 seconds. Removal publishes game-session revocation first, then attempts up to eight immediate media cutoffs. The registered `jobs-media-access` worker runs every 15 seconds, prioritises invalid login credentials awaiting their first successful cutoff among up to 128 due grants, and reconciles provider inventory. Inventory uses a separate 128-participant budget across up to 32 rooms, with per-room cursors. Actual completion latency depends on backlog and provider/database availability; 15 seconds is a scheduling interval, not a universal cutoff guarantee.

Every provider request uses the existing SDK's five-second abort timeout with regional failover disabled. Independent participant mutations are attempted with bounded concurrency and failures are reported after the other mutations settle. Failure logs retain retry visibility. A failed inventory request is unknown state, never proof of absence; structured `not_found` is the only accepted absence response. Revocation still attempts `RemoveParticipant` when room enumeration or participant inventory fails. Known grants remain durable for later passes.

The first successful cutoff retains at least a 660-second refreshed-token tail and returns the grant to the fair maintenance queue. Observing an active participant extends retention, including a revoked participant seen reconnecting. A grant is pruned only after its retention deadline and a successful absent-participant observation. Role changes fan out across a player's media identities. Current room authority is checked as well as login authority: ended calls, departed call members, unavailable Spaces, missing venue/street presence and exhausted street minutes are refused. An authority outage causes exact-identity removal and retains the retry error.

Only an actual voice-room member with no remaining registered, active credential media can cause player-level departure bookkeeping or paid-call termination. Provider inventory and database updates are separate systems, so this is not an atomic presence guarantee. Delayed leave events do not remove a newer same-identity connection visible in current inventory. Room termination attempts issued-grant cutoffs and provider room deletion; the worker retries failures using the ended room's durable authority.

## Remaining paid-call billing acceptance gap

A lost `participant_left` webhook can leave a paid call marked live until the existing booked-duration sweep ends it. Media revocation and this reconciliation worker do not establish the exact charged duration or repair missed departure billing. Provider-presence reconciliation tied to the call's actual participants, together with billing reconciliation, remains required before real paid-call acceptance. The media-access tests do not prove paid-call billing correctness.

## Provider limits and cutover

LiveKit Cloud supports cached-token revocation; self-hosted removal does not. Cloud retains cutoffs for ten minutes, and refreshed tokens have at least a ten-minute lifetime. Short initial TTL alone does not terminate an active connection. [Token lifecycle](https://docs.livekit.io/frontends/reference/tokens-grants/).

Cutoffs use `revokeTokenTs = current Unix second + 5` to cover same-second issuance. LiveKit requires the explicit cutoff to be within sixty seconds of its clock; actual clock and reconnect behaviour require provider acceptance. [Participant removal](https://docs.livekit.io/intro/basics/rooms-participants-tracks/participants/).

Legacy bare-player identities have no credential binding and are retired by the new inventory/webhook enforcement. Their previously issued, unregistered tokens may last an hour and outlive a single Cloud cutoff. Before claiming strict production revocation, stop old issuers and coordinate the API, workers, migration and compatible clients. Drain legacy connections and refreshed grants, then either retire the old provider signing key or wait through the longest old issuance lifetime plus refreshed-token tail while enforcing inventory cutoff. No key rotation or deployment is performed by this change.

Local SDK/database tests do not prove LiveKit Cloud rejection, native microphone behaviour or browser acceptance. Self-hosted webhook removal is post-admission enforcement and cannot be described as pre-admission rejection. Actual provider/platform acceptance remains outstanding.
