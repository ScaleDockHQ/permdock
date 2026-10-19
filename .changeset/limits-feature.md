---
"permdock": minor
---

Grant limits are an opt-in feature: `limits` takes `limits(store)` instead of a bare `LimitStore`. The counting code ships only with apps that import `limits`, so a plain `definePolicy` + `getPermDock` bundle drops from 40.1 KB to 39.6 KB gzip, and `permdock/server` from 42.1 KB to 41.7 KB.

| Before                                              | After                                                       |
| --------------------------------------------------- | ----------------------------------------------------------- |
| `createPermDock(policy, user, { limits: store })`   | `createPermDock(policy, user, { limits: limits(store) })`   |
| `defineApp(policy, { limits: memoryLimitStore() })` | `defineApp(policy, { limits: limits(memoryLimitStore()) })` |

A grant with a `limit` and no `limits` still denies with `limit-unavailable`, `dev` still fills in `limits(memoryLimitStore())`, and `prod` still throws at startup.
