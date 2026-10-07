---
"permdock": minor
---

`permdock rls generate` now emits `permdock_role_permissions(p_role, p_scope, p_tenant, p_scope_id)` and `permdock_permission_keys()`, so role editors and admin screens no longer hand-write the join over `role_permissions` and the custom-role tables. The first returns the permission keys a role holds on a scope with `allow` or `deny`: a declared role from `role_permissions`, and with `rls.customRoles` in `database` mode a custom role of the caller's tenant, resolved through the ceiling as `resolveCustomRole` does. Only a member of the tenant (or a `meta.manageRoles` holder for a platform role) may read a custom role. The second lists every declared permission key. Both are executable by `authenticated` and not by `anon`. The change adds two functions to the helpers file and breaks nothing.
