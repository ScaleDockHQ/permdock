---
"permdock": major
---

Grant limits are an opt-in feature: `limits` takes `limits(store)` instead of a bare `LimitStore`. The counting code ships only with apps that import `limits`, so a plain `definePolicy` + `createPermDock` bundle drops from 40.1 KB to 39.6 KB gzip, and `permdock/server` from 42.1 KB to 41.7 KB.

| Before                                                    | After                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------- |
| `createPermDock(policy, user, { limits: store })`         | `createPermDock(policy, user, { limits: limits(store) })`           |
| `defineApp(policy, { limits: memoryLimitStore() })`       | `defineApp(policy, { limits: limits(memoryLimitStore()) })`         |
| `defineApp(policy, { profile: "dev" })` filled in a store | Pass `limits` yourself; without it a `limit` grant denies as before |

The `dev` profile no longer fills in a memory `LimitStore`: doing so put the counting code in every app. A grant with a `limit` and no `limits` still denies with `limit-unavailable`, and `prod` still throws at startup. `permdock init` writes `limits: limits(memoryLimitStore())` for a preset with limits.
