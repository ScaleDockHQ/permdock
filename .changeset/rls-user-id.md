---
"permdock": patch
---

On Supabase, `permdock rls generate` writes `permdock_user_id()` into the helper schema, and every generated helper, policy, field view and trigger reads the subject through it in every mode. It returns what `auth.uid()` returns, reading the `request.jwt.claim.sub` setting first and then the `sub` of `request.jwt.claims`, and returns null for a token whose `sub` is an empty string, such as a tenant service key, where `auth.uid()` fails the uuid cast. Code and tests that impersonate a user by setting only `request.jwt.claim.sub` get the same user from the helpers as from a policy that calls `auth.uid()`, with or without `rls.apiKeys`. `execute` on the function follows the helpers' grants, and an `anon` policy that reads the subject now grants `anon` the helper schema as `rls.anonExecute` does. The Supabase manifest lists it in `rls.helpers`, and `rls import` reads it as `principal.id`. Regenerate and apply the migration.
