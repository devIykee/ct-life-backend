# Logs and IP addresses

What the backend itself writes and keeps. (The account-deletion list of erased data lives in
PRIVACY.md once #29 lands.)

## Application logs (pino, JSON on stdout)

- Every HTTP request line has `req: {method, path, ip}` and the response status. Nothing else
  of the request: no headers (so no `Authorization` or cookies), no body, **no query string**
  (it can carry handles and ids), no port.
- `ip` is the client address as Fastify resolves it (`trustProxy: true`, so the
  `X-Forwarded-For` client, not the proxy), **truncated before it is logged**: IPv4 to /24
  (`203.0.113.0`), IPv6 to /48 (`2001:db8:85a3::`). See `truncateIp` in
  `server/shared/logger/logger.ts`; the test `log-privacy.test.ts` fails if a full address,
  a query string or a port reaches a log line.
- Coordinates (`lat`, `lng`, ...), seeds, secrets and private keys are redacted by `REDACT_PATHS`.
- Application code does not log `req.ip` itself.

## Where a full IP still exists

| Where                                                | What                                                         | How long                                                                                                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Redis `rl:login:ip:<ip>`                             | login attempt counter for the per-IP limit on `/auth/verify` | 60 seconds, then expires                                                                                                                                                 |
| Postgres                                             | no table stores an IP address                                | n/a                                                                                                                                                                      |
| Reverse proxy / hosting platform in front of the API | access logs, if the platform keeps them                      | **[Unverified]** set by the hosting provider's account settings; not controlled by this repo. Check the deployment's log retention before publishing the privacy policy. |

## Not verified

- The Colyseus realtime server's own logging was not audited for client addresses. **[Unverified]**
  It is started through the same logger for application messages, but the transport layer's logs
  were not inspected.
- Object storage (S3/MinIO) access logs, if enabled by the operator, are outside this repo.
