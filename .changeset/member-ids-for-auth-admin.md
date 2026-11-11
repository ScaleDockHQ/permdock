---
"permdock": patch
---

The hook file grants `supabase_auth_admin` execute on every `member_<scope>_ids_for` the helpers write, not only with `supabase.hook.claims` or `supabase.hook.teams`, and the manifest lists the role. `authorizationProvider` fills better-supabase's `memberIdsFor` only where the manifest lists that grant, so it never declares a grant the SQL lacks: an `rls.authorize: 'database'` project without a hook leaves `memberIdsFor` unset. Run `permdock generate`.
