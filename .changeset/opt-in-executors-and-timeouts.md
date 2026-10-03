---
"permdock": patch
---

Smaller server bundles, bounded network calls and a faster policy lookup.

OpenTelemetry and Web Bot Auth now reach an app's bundle only when it imports them. The adapter options take the function instead of its options, and `applyOtel` is gone:

| Before                               | After                                                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `otel: { logger }`                   | `otel: (permdock) => withOtel(permdock, { logger })`, with `withOtel` from `permdock/otel`                                                        |
| `webBotAuth: { verify: true, keys }` | `webBotAuth: (request) => verifyWebBotAuth(request, { verify: true, keys })`, with `verifyWebBotAuth` from the adapter entry or `permdock/server` |

`OtelWrap` (from `permdock/otel`) and `WebBotAuthVerifier` (from `permdock/server`) type the two options. A Hono app without either option ships about 1.6 KB gzip less; `permdock/next` and `permdock/mcp` about 1.9 and 2.4 KB less.

Every outbound request now has a default timeout: JWKS and discovery 5 seconds (`jwksCache.timeout` changes it), Web Bot Auth key directories 5 seconds, Cloud requests 10 seconds, the React provider's endpoint calls 10 seconds, terminal device, token and CI OIDC requests 10 seconds, and SSF polls 30 seconds. An aborted request fails closed like an unreachable endpoint. Concurrent JWKS and discovery fetches for one issuer share a single request.

`definePolicy` indexes grants by permission key once, so a check no longer scans every grant.

The CLI reports a missing optional peer (`pg`, `pgsql-parser`) with its install line only when the module is missing; any other load error surfaces as it is.
