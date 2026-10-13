---
"permdock": minor
---

Times follow one rule: NumericDate in JWT and SQL-read claims, RFC 3339 in JSON records and HTTP bodies, whole seconds for durations, and an `Instant` (`{ epochMilliseconds }`, such as a `Temporal.Instant`) for every runtime `now`. A duration that is not a positive integer throws at definition time, and a `now` that is not an `Instant` denies with `validation`.

| Before                                                                                                              | After                                       |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Credential `createdAt`, `expiresAt`: Unix seconds                                                                   | RFC 3339                                    |
| `apiKeyVerifier` `touch(id, at)`: `at` in Unix seconds                                                              | `at: Instant`; `lastUsedAt(id)` is RFC 3339 |
| `approval.ttl`, `escalation.after`: `"30m"`                                                                         | `1800` (seconds)                            |
| `memoryApprovalStore({ ttl })`, `requestApproval` `ttl`: milliseconds                                               | seconds                                     |
| `DEFAULT_APPROVAL_TTL_MS` (3 600 000)                                                                               | `DEFAULT_APPROVAL_TTL` (3600)               |
| `limit: { per: "1h" }`                                                                                              | `limit: { per: 3600 }`                      |
| `breakGlass` / `supportAccess` `maxDuration`, `consent.durations`, `activate({ duration })`: `"4h"`                 | `14_400` (seconds)                          |
| `remotePdp` / Clerk resolver `cache.ttl`: `"5s"` or milliseconds                                                    | `5` (seconds, at most 30)                   |
| Connection `revalidate`: milliseconds                                                                               | seconds                                     |
| `validFrom`, `validUntil`: RFC 3339 or Unix seconds                                                                 | RFC 3339 or an `Instant`                    |
| Snapshot and catalog grant `validity`, `inactive-grant` detail: Unix seconds                                        | RFC 3339 (`WireValidity`)                   |
| `LimitDetail`: `{ count, window, resetsAt: number }`                                                                | `{ count, per, resetsAt: string }`          |
| `quota.resetsAt`: Unix seconds                                                                                      | RFC 3339                                    |
| `now` on `decide`, `can`, `simulate`, `compileWhere`, ORM `toWhere`, `rateLimitHeaders`, limit stores: Unix seconds | `Instant`                                   |
| `now` on approval helpers, stores, `approverRelations`, access reviews: `Date`                                      | `Instant`                                   |
| Terminal runtime `now` and `WebBotAuthOptions.now`: `() => number`                                                  | `() => Instant`                             |
| `buildLocalSnapshot(manifest, data, now)`, `signSaasToken({ now })`, `verifySaasToken(token, now)`: Unix seconds    | `Instant`                                   |
| `parseDuration`                                                                                                     | Removed                                     |
