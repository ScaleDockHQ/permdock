---
"permdock": minor
---

A membership role column that stores a role id is read as a key through a roles table: `fromTable` `columns.role`, `fromJunction` `roles`, an `rls.memberships` table's `role` and `authorizeSql`'s `tenant.role` take `{ through, on, column }`, the shape `rls.roles` already takes. The token hook, in-process `membershipsFor` and `list`, the `database` mode helpers, the custom-role match, the ownership triggers, `permdock_can_assign` and `memberOf` all join the roles table, `supabase_auth_admin` gets read access to it, `permdock_bump_authz_version_role_keys` bumps every global and membership holder of a renamed key, the manifest's membership `role` carries `through`, and doctor PD028 counts the roles table's id and key columns. `permdock_can_assign` now also answers from membership sources in `database` mode.
