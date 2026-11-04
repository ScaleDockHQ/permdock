---
"permdock": patch
---

On the `supabase` dialect in `database` mode, `permdock_has(p_grant)` memoizes its answer per statement in `permdock.m.global.k<bucket>`, keyed and invalidated like `permitted_<scope>_ids`. A policy site and every `permdock_has_permission` grant key now read the memo, so the global role and custom role lookup runs once per grant key per statement instead of once per call. The function becomes `volatile` `plpgsql`; `permdock_has_for` is unchanged. Regenerate the helpers and add the changed function to a migration.
