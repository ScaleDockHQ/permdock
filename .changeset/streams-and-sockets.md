---
'permdock': minor
'@permdock/testing': minor
---

Authorization for streams and sockets ([ADR 0052](https://permdock.com/docs/decisions/0052-streams-and-sockets)). The server kernel and the Hono, tRPC, oRPC, Elysia and Nest adapters expose `connection(...)`, which returns a frozen `Connection` with `permdock`, `signal`, `check`, `filter` and `close`. Its `signal` aborts with a `PermDockRevokedError` in four cases: a revoked session, an expired subject, a re-denied opening permission, or a changed principal. A new `RevocationFeed` interface (`memoryRevocationFeed()` in `permdock`), passed as `revocations`, ends connections on `session-revoked` and revalidates them on `changed`. `permdock/ssf` and `permdock/scim` publish to it.

Per adapter:

- Hono adds `socket(conn, events)` and `sse(conn, stream, source, options)`.
- tRPC subscriptions and oRPC event iterators behind `protect(permission, load, { items })` drop unreadable items, and end with `UNAUTHORIZED` or `FORBIDDEN`.
- Elysia and Nest close revoked sockets with `1008`.

`problemFromError` maps `PermDockRevokedError`. `@permdock/testing` adds `testRevocationFeed`, four `stream-*` scenarios in `testHttpAdapter({ streams: true })`, and `verifySaasSession`. The shared SaaS policy now accepts a full `Subject`.
