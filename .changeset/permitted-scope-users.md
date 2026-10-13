---
"permdock": minor
---

`permdock rls generate` in `database` mode writes `permitted_<scope>_users(p_permission, p_id)` for each scope whose memberships are in a table: the users who hold a permission key on one instance, through a membership there or a global role, with denies, custom roles, expiry and suspension applied as `permitted_<scope>_ids_by_permission_for` applies them. No client role may execute it; grant `execute` to the backend role that calls it. The Supabase manifest lists it in `rls.helpers`, and `supabase-manifest-v1.json` accepts the name, so a reader validating against the previous schema rejects a manifest that lists it.
