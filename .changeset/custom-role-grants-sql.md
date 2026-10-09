---
"permdock": minor
---

`permdock rls generate --custom-roles` in `database` mode emits `permdock_replace_custom_role_grants`, `permdock_rename_custom_role_grants` and `permdock_delete_custom_role_grants`. They save, rename and delete a custom role's rows with the rules of `validateCustomRole` and `assignablePermissions`, checked against the signed-in caller, so an application no longer hand-writes a `security definer` function for it. A null tenant with scope `global` writes a platform custom role, checked against the global ceiling and global grants, and a caller holding a `meta.manageRoles` permission through a global role passes the membership check for any tenant.

The `permdock_trusted_replace_custom_role_grants`, `permdock_trusted_rename_custom_role_grants` and `permdock_trusted_delete_custom_role_grants` variants keep the definition checks without the caller checks, for migrations, jobs and backends; only the owner may execute them until a migration grants a role.
