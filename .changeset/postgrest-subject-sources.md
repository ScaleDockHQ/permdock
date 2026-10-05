---
"permdock": minor
---

The hook file now defines `subject_for(p_user uuid) returns jsonb`: the global roles, memberships, authorization version and, in `database` mode with `rls.customRoles`, the held custom roles the hook would put in a token for `p_user`, or `{ id, active: false }` for a suspended user. No client role may execute it. `postgrestSources(client, { schema?, fn? })` in `permdock/supabase` reads it through supabase-js once per user and returns `memberships` (with `version`, for `claimsFirst`), `customRoles(principal)` and `subject(userId)`, so a backend without a `SqlQuery` no longer re-implements the membership sources, the suspension filter and a custom-role reader with the admin client.
