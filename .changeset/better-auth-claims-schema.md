---
"permdock": minor
---

Breaking: `subjectFromBetterAuth` from `permdock/better-auth` no longer copies the user's additional fields into `principal.claims` without `options.schema`, because a user can edit their own additional fields. Pass a Standard Schema that lists the server-set fields to keep: `subjectFromBetterAuth(auth, session, { schema: z.object({ plan: z.string() }) })`.
