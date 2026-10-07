---
"permdock": patch
---

A snapshot check reads the clock only when a grant needs it. A `usePermission` hook under a `PermDockProvider` that is still awaiting its `snapshotPromise` no longer calls `Date.now()`, so it renders in a Next.js Cache Components static shell without a Suspense boundary.
