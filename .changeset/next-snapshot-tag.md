---
'permdock': minor
---

`snapshotTag(sub)` from `permdock/next` returns the cache tag for a user's snapshot entries (`permdock:<sub>`, or `permdock:anon` without one), so a private-cache loader and the Server Action that changes roles agree on one string. The Next.js Cache Components guide gains the better-supabase recipe: `next.cached()` inside `'use cache: private'`, `stale` capped by both `sessionStale(session)` and `cacheLifeFor(snapshot)`, and `updateTag(snapshotTag(sub))` with `next.invalidateSession(sub)` after a role change. Its URL-slug loader now takes the org id and never calls `notFound()` inside the private cache. The new `apps/examples/next-better-supabase` runs that recipe in snapshot-only mode against Postgres in testcontainers, and its e2e spec asserts under `instant()` that the snapshot rides the prefetch. `permdock doctor` PD014 now accepts a shorthand `issuer` property next to `jwks`.
