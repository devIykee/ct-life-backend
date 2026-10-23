# Push notifications (Firebase Cloud Messaging)

The server sends push through **FCM HTTP v1** to the devices registered with
`POST /v1/push/register` (`push_devices`). It is **off until you configure it**: with no
credentials every send is a logged no-op and nothing else changes. Credentials are never
committed; they live in the host's secret store.

Only devices with an **FCM token** (`android`, `web`) are reached. An iOS device that registered
only an APNs token is skipped (the game ships on Android/Seeker).

## What you must do (Firebase, about 10 minutes)

1. **Create the Firebase project.** Firebase console > Add project (a Google account is enough;
   Cloud Messaging is free). Note the **project id** (for example `ct-life-prod`).
2. **Add the Android app** to the project, using the client's `applicationId` (the Android
   package name set in the Unity project's Android player settings, for example `dev.ctlife.game`).
   It must match exactly, or tokens will not be issued.
3. **Download `google-services.json`** from that app's settings and give it to the client
   (frontend) repo. It is client config, not a server secret.
4. **Create a server credential.** Project settings > Service accounts > Generate new private
   key. This downloads a JSON file with `client_email` and `private_key`. Treat it like a
   password.
5. **Set these on the server** (API and workers; copy `.env.example`):

   ```
   FCM_PROJECT_ID=ct-life-prod
   FCM_SERVICE_ACCOUNT_JSON={"type":"service_account", ... }   # the file's contents on one line
   # or, instead of the JSON, a path to the file on the host:
   FCM_SERVICE_ACCOUNT_PATH=/run/secrets/fcm.json
   ```

   Restart the workers. A warning line `push: ... push is off` at startup means the values were
   missing or unreadable.

6. The service account needs the role **Firebase Cloud Messaging API Admin** (the default
   Firebase service account has it).

The server asks Google for a short-lived access token with scope
`https://www.googleapis.com/auth/firebase.messaging` (JWT signed with the service-account key,
no extra library) and posts to `https://fcm.googleapis.com/v1/projects/{FCM_PROJECT_ID}/messages:send`.

**Not verified against live FCM.** The unit tests use a mocked `fetch`; the request shapes follow
Google's published docs (OAuth service-account flow, `messages:send`, `UNREGISTERED` = HTTP 404).
The first real send should be checked on a device. The `android.priority: HIGH` field and the
string-only `data` map are from the FCM reference and not exercised against the live service.

## What the server sends

| Type             | When                                                                                     | `deep_link`           |
| ---------------- | ---------------------------------------------------------------------------------------- | --------------------- |
| `streak_ending`  | From 3 h before the UTC reset, to players who claimed yesterday and not today            | `ctlife://quests`     |
| `daily_clue`     | Once per UTC day, to players who have not answered the clue                              | `ctlife://daily-clue` |
| `liquidated`     | A perp is liquidated                                                                     | `ctlife://perps`      |
| `home_visit`     | Someone visits your home (once per home per UTC day)                                     | `ctlife://home`       |
| `event_starting` | A stub for the event calendar (R2): `notifyEventStarting()` exists, nothing calls it yet | `ctlife://events`     |

Each message is an FCM `notification` (title, body) plus a `data` map with `type` and
`deep_link`. On tap the client reads `deep_link` and opens that screen.

## Limits and preferences

- At most **4 pushes per player per UTC day**, across all types. Further sends are dropped.
- **Quiet hours** per player, in local time via `tzOffsetMin` (default on, 22:00 to 08:00, offset 0).
  A push held by quiet hours is not queued: the streak and clue sweeps try again every 5 minutes,
  event-driven ones (liquidated, home visit) are dropped.
- **Opt-out per type** with `disabledTypes`. `GET` / `PUT /v1/push/prefs`.
- One push per (player, key): a sweep or retry never repeats a push.
- A token FCM reports as `UNREGISTERED` is disabled in `push_devices`.

## Client checklist

- Request the notification permission (Android 13+ `POST_NOTIFICATIONS`), then get the FCM token
  and call `POST /v1/push/register {platform: "android", fcmToken}`.
- `PUT /v1/push/prefs` with the device's UTC offset in minutes.
- Handle `deep_link` from the notification tap, both from a cold start and while running.
