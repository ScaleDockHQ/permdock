---
"permdock": minor
---

On Supabase, `permdock rls generate` writes `permdock_user_id()` into the helper schema, and every generated helper, policy, field view and trigger reads the subject through it in every mode. It reads the `sub` of `request.jwt.claims` and returns null for a token whose `sub` is an empty string, such as a tenant service key, where `auth.uid()` fails the uuid cast. `execute` on the function follows the helpers' grants, and an `anon` policy that reads the subject now grants `anon` the helper schema as `rls.anonExecute` does. The Supabase manifest lists it in `rls.helpers`, and `rls import` reads it as `principal.id`. Regenerate and apply the migration.

Breaking: `withSubject` in `permdock/drizzle`, `permdock/kysely` and `permdock/prisma` and `permdock rls verify` no longer set `request.jwt.claim.sub`. A test or job that sets only `request.jwt.claim.sub` sets `request.jwt.claims` with a `sub` instead. Doctor check PD062 reports migrations that still read or set a `request.jwt.claim.<name>` setting.
