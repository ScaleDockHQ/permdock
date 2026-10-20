---
"permdock": minor
---

`rls.customRoleWrites.roles.primaryKey` makes `permdock rls generate` write `permdock_replace_custom_role_grants_by_id(role_id, permissions)`, its trusted variant and `permdock_trusted_role_permissions_by_id(role_ids)`: the role row supplies the tenant, scope and name, the existing caller and definition checks apply, and `rls.customRoleWrites.audit` names the function that records each save. `rls.trustedReaders` roles now also get `usage` on the helper schema, without which their execute grants could not be used.
