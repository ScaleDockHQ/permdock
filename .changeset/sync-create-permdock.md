---
"permdock": major
---

Core `createPermDock` is synchronous and returns a `PermDock`, never a Promise. Inputs that answer asynchronously go through the new `loadPermDock`, which takes the same arguments and returns `Promise<PermDock>`. `permdock/pdp` has the same pair. Passing a Promise-returning mapper or source to `createPermDock` throws and names `loadPermDock`, instead of handing back a value that might be a Promise.

| Before                                                                        | After                                                                 |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `const permdock = await createPermDock(policy, user)` with synchronous inputs | `const permdock = createPermDock(policy, user)`                       |
| `await createPermDock(policy, user, { memberships: dbSource })`               | `await loadPermDock(policy, user, { memberships: dbSource })`         |
| `createPermDock` from `permdock/pdp` (always async)                           | `createPermDock` (sync) or `loadPermDock` (async) from `permdock/pdp` |
| Adapter option `pdp: createPermDock` from `permdock/pdp`                      | `pdp: loadPermDock` from `permdock/pdp`                               |
| `permdock.derive(options)` returned `PermDock \| Promise<PermDock>`           | `permdock.derive(options)` always returns `Promise<PermDock>`         |

`await createPermDock(...)` on synchronous inputs still works at run time, but a type-aware linter flags it (`await-thenable`). Server and agent adapters build each request's instance with `loadPermDock`, so their sources may stay async.
