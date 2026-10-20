---
"permdock": minor
---

Add shared custom roles: a `CustomRole` with `shared: true` and no tenant, returned by `CustomRoleSource.sharedRoles()`, is held on a membership of its scope in every tenant, and its name wins over a tenant role's (`validateCustomRole(policy, role, { shared })` reports `name-taken`). Generated RLS resolves them from rows with a null `tenant_id` below the global scope, and `permdock_replace_custom_role_grants` writes them only for a caller holding `meta.manageRoles` through a global role.
