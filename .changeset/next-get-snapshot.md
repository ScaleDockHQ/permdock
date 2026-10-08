---
"permdock": minor
---

`permdock/next`: the factory returns `getSnapshot({ tenant?, include?, tenants?, tags? })`. Call it inside your own `'use cache: private'` function: it builds the session's snapshot and calls `cacheLife(cacheLifeFor(snapshot))` and `cacheTag(snapshotTag(sub), ...tags)` in that scope. `PermissionBoundary` `denied` and `approval` also accept a function of the boundary state.
