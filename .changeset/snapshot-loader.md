---
"permdock": minor
---

`createPermDock` from `permdock/server` returns `getSnapshot(request, { tenant, include, tenants })` for React Router, TanStack Start, SvelteKit and Nuxt loaders, reusing the request's cached subject. `snapshotHeaders(snapshot, { tags })` returns a private `Cache-Control` capped at `expiresAt`, `Vary`, an `ETag` and `Cache-Tag`. `cacheLifeFor` and `snapshotTag` are now exported from `permdock/server` as well as `permdock/next`.
