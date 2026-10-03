---
"permdock": minor
---

`permdock rls generate` emits `member_<scope>_ids()` for every declared scope: the instances the caller holds any live membership of, with no permission key, for policies such as an organization switcher or "members read their organization's row". In `database` mode the helpers read the `fromTable` / `fromJunction` sources in the new `rls.membershipSources` (default `supabase.hook.memberships`) for every scope `rls.memberships` maps no table for, so the helpers, the token hook and the application's `MembershipSource` run the same SQL. `rls import` reads `col in (select member_<scope>_ids())` back as a `memberOf` with no roles, and the hook manifest lists the new helpers.
