---
"permdock": minor
---

`rls generate --custom-roles` in `database` mode now works with membership sources (`fromTable`, `fromJunction`, `rls.membershipSources` or `supabase.hook.memberships`) instead of failing with `--custom-roles in database mode needs rls.memberships.scopes.<scope>`. Each `permitted_<scope>_ids` unions a custom-role branch over the source rows, matching `custom_role_permissions` and `custom_role_includes` on the row's first-scope instance as `tenant_id` and its id as `scope_id`, through the same `permdock_ceiling` view as a membership table.
