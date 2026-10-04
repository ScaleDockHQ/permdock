---
"permdock": patch
---

Custom roles with `scope: 'global'` are platform roles held through `principal.roles`, capped by the allows of assignable global roles and returned by the new `RoleSource.globalRoles()`. With `rls generate --custom-roles` they are rows with a null `tenant_id`, or the top-level `role_grants` claim in `jwt` mode, and `permdock_has` answers from them.
