---
"permdock": minor
---

`snapshotTag(sub)` from `permdock/next` returns the cache tag for a user's snapshot entries (`permdock:<sub>`, or `permdock:anon` without one), so a private-cache loader and the Server Action that changes roles agree on one string. The Next.js Cache Components guide gains the better-supabase 0.4 recipe: `bs.cached({ tags })` inside `'use cache: private'`, `stale` capped by both the session and `cacheLifeFor(snapshot)`, and `bs.invalidateSession(sub, { tags: [snapshotTag(sub)] })` after a role change. Its URL-slug loader now takes the org id and never calls `notFound()` inside the private cache. The new `apps/examples/next-better-supabase` runs that recipe in snapshot-only mode against Postgres in testcontainers, and its e2e spec asserts under `instant()` that the snapshot rides the prefetch. `permdock doctor` PD014 now accepts a shorthand `issuer` property next to `jwks`.
