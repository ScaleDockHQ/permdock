---
"permdock": patch
---

`rls generate` grants `supabase_auth_admin` execute on every `member_<scope>_ids_for` it writes, next to the function, and the manifest lists the role. better-supabase's `memberIdsFor`, which `authorizationProvider` fills whenever the manifest lists the helper, now has the grant it declares without `supabase.hook.claims` or `supabase.hook.teams`, and in `rls.authorize: 'database'` mode without a hook. A single migration file wraps the grant in a `do` block that runs only where the role exists; a `--split` schema file grants it outright. Run `permdock generate`.
