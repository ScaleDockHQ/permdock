---
"permdock": major
---

Feature requests are free functions that take the instance first, so `createPermDock` no longer references their modules and an app that does not call them does not ship them. A plain `definePolicy` + `createPermDock` bundle drops from 54.3 KB to 46.7 KB gzip, and `permdock/react` from 21.8 KB to 19.4 KB (measured with esbuild, minified, tree-shaken).

| Before                                            | After                                              |
| ------------------------------------------------- | -------------------------------------------------- |
| `permdock.decideCredential(request, options)`     | `decideCredential(permdock, request, options)`     |
| `permdock.decideAutomation(request, options)`     | `decideAutomation(permdock, request, options)`     |
| `permdock.decideSupportSession(request, options)` | `decideSupportSession(permdock, request, options)` |
| `permdock.activate(input)`                        | `activate(permdock, input)`                        |
| `permdock.whoCan(permission, row)`                | `whoCan(permdock, permission, row)`                |
| `permdock.simulate({ arazzo, openapi })`          | `simulateArazzo(permdock, { arazzo, openapi })`    |

All six are exported from `permdock`. On an instance built from a snapshot they deny with `unsupported` (`whoCan` lists nothing), as the methods did; on a `PdpPermDock` they use its local instance. `simulateArazzo` emits one `simulate` event per plan on a server instance.
