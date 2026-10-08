---
"permdock": minor
---

Server decisions do less work per request. The decision endpoints look permissions up by key, build their handler once and reuse the request's subject; tRPC and oRPC subscriptions open with the row `protect` loaded; Nest rules sharing a `loadData` run it once; Fastify routes opt out with `config: { permdock: false }`.

`withSubject` (Drizzle, Kysely, Prisma) sets the role and claims in one `select set_config(…)` statement. `subjectFromBetterAuth` reads every member row in one adapter query, and `createClerkSubjectResolver({ cache: { ttl } })` caches each user's `memberships: 'all'` list for up to 30 seconds.
