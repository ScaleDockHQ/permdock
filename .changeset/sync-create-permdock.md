---
"permdock": major
---

Core and `permdock/pdp` replace `createPermDock` with `getPermDock`, which takes the same arguments and returns `Promise<PermDock>`, and `getPermDockSync`, which returns a `PermDock` and never a Promise. Passing a Promise-returning mapper or source to `getPermDockSync` throws and names `getPermDock`, instead of handing back a value that might be a Promise. Adapters keep `createPermDock`.

| Before                                                                        | After                                                                 |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `const permdock = await createPermDock(policy, user)` from `permdock`         | `const permdock = await getPermDock(policy, user)`                    |
| `createPermDock(policy, user)` with synchronous inputs, where a Promise hurts | `getPermDockSync(policy, user)`                                       |
| `createPermDock` from `permdock/pdp` (always async)                           | `getPermDock` (async) or `getPermDockSync` (sync) from `permdock/pdp` |
| Adapter option `pdp: createPermDock` from `permdock/pdp`                      | `pdp: getPermDock` from `permdock/pdp`                                |
| `permdock.derive(options)` returned `PermDock \| Promise<PermDock>`           | `permdock.derive(options)` always returns `Promise<PermDock>`         |

Server and agent adapters build each request's instance with `getPermDock`, so their sources may stay async.
