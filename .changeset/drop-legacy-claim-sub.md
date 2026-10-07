---
"permdock": minor
---

The generated `permdock_user_id()` reads only the `sub` of `request.jwt.claims`, and `withSubject` in `permdock/drizzle`, `permdock/kysely` and `permdock/prisma` and `permdock rls verify` no longer set `request.jwt.claim.sub`. This is a breaking change for a test or job that sets only `request.jwt.claim.sub`: set `request.jwt.claims` with a `sub` instead, then regenerate with `permdock rls generate`. Doctor check PD062 reports migrations that still read or set a `request.jwt.claim.<name>` setting.
