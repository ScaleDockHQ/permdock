---
"permdock": patch
---

`member_<scope>_ids_for` is executable by `supabase_auth_admin` whenever `rls generate` writes it: the helpers file grants it, with usage on the helper schema, and the manifest lists the role. The hook no longer grants it only with `supabase.hook.claims` or `supabase.hook.teams`, so better-supabase's `memberIdsFor`, which `authorizationProvider` fills whenever the manifest lists the helper, has the grant it declares, in `rls.authorize: 'database'` mode without a hook too. Run `permdock generate`.
