# IRL event check-in: privacy note

Applies to `POST /v1/events/{slug}/checkin` (Breakpoint 2026, Olympia London, so UK GDPR applies). This describes what the code does; it is an engineering note, not legal advice. [Unverified] A DPIA / lawful-basis review by the controller is still needed before launch.

## What the player does

Nothing happens in the background. The player taps "check in" at the venue; the app sends the phone's current position once. It is opt-in, only during the event window, and the board listing is a second, separate opt-in (default hidden).

## What the server stores

Exactly one row per player per event, in `event_checkins`:

| column          | why                                                            |
| --------------- | -------------------------------------------------------------- |
| `event_id`      | which event                                                    |
| `user_id`       | who; the primary key (event, user) makes the reward one-time   |
| `checked_in_at` | when; orders the board                                         |
| `visible`       | the player's own choice to appear on the board (default false) |

The reward is recorded in the ordinary ledger (`event_irl_bonus`) and cosmetic inventory (`source = grant`).

## What the server does NOT store or expose

- Latitude, longitude, reported accuracy and the computed distance. They are read from the request, compared with the venue circle in memory, and dropped. They are not written to any table, cache, queue or error. A rejection returns only a reason code (`outside_geofence`, `poor_accuracy`, ...), never a distance.
- Request bodies and coordinate fields in logs: Fastify does not log bodies, and the API logger additionally redacts `req.body`, `body`, `lat`, `lng`, `latitude`, `longitude`, `accuracyM` (`REDACT_PATHS` in `server/shared/logger/logger.ts`, covered by a test). Reverse proxies and CDNs in front of the API must not log bodies either; that is outside this code.
- The attendee board (`GET /v1/events/{slug}/irl`) returns alias, look, tribe, avatar id and `checkedInAt` only, for players who opted in, minus anyone blocked in either direction. No location and no user id. The `irl_checkin` city message carries the alias only.

The venue geofence (centre, radius, source) is public venue data stored on `events`, not personal data.

## Limits

- The position is reported by the phone. The mock-location flag, the 150 m accuracy cap and the account-age rule (created before the event start) make cheating costlier; they cannot prove presence.
- `checked_in_at` and `visible` are personal data (they say that a player attended an event). They are deleted with the user (`ON DELETE CASCADE`) and with the event.
