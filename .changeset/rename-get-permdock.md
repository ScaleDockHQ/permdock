---
"permdock": major
---

Breaking: core and `permdock/pdp` build an instance with `getPermDock` (async) or `getPermDockSync`, so `create*` means a module-scope factory, `get*` a per-request server read and `use*` a client read. `permdock/next` renames `requireAccess` to `requirePermission`, which takes `getPermission`'s arguments. Run `permdock codemod 0.5` for the renames below; the call-shape change in the second table needs a manual edit.

| Old              | New                 | Entry                                                     |
| ---------------- | ------------------- | --------------------------------------------------------- |
| `createPermDock` | `getPermDockSync`   | `permdock`                                                |
| `createPermDock` | `getPermDock`       | `permdock/pdp`                                            |
| `loadRelations`  | `prefetchRelations` | the `PermDock` method, from `permdock` and `permdock/pdp` |

| Before                                                  | After                                                       |
| ------------------------------------------------------- | ----------------------------------------------------------- |
| `requireAccess({ permission, data, tenant, onDenied })` | `requirePermission(permission, data, { tenant, onDenied })` |
| `RequireAccessInput`                                    | `PermissionRequirementOptions`                              |

`await createPermDock(…)` from `permdock` becomes `await getPermDock(…)`.
