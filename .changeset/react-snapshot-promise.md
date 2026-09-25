---
'permdock': minor
---

`permdock/react`'s `PermDockProvider` accepts `snapshotPromise`, an unawaited snapshot from a Server Component. Hooks suspend through `use()` until it resolves, and `<Protected pending>` becomes the Suspense fallback. The server `PermDockProvider` from `permdock/next` no longer awaits: it streams a `snapshotPromise` and fails closed to an empty snapshot. It also adds `cacheLifeFor(snapshot, { min, max, now })`, which returns `{ stale }` for an app-owned `'use cache: private'` loader, and removes the unused `tag` option from `permdock/next`.
