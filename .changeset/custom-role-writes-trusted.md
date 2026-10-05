---
"permdock": minor
---

`rls generate --custom-roles` in `database` mode writes platform custom roles: `permdock_replace_custom_role_grants`, `permdock_rename_custom_role_grants` and `permdock_delete_custom_role_grants` take a null tenant with scope `global`, checked against the global ceiling and global grants. A caller holding a `meta.manageRoles` permission through a global role now passes the membership check for any tenant. New `permdock_trusted_replace_custom_role_grants`, `permdock_trusted_rename_custom_role_grants` and `permdock_trusted_delete_custom_role_grants` keep the definition checks without the caller checks, for migrations, jobs and backends; only the owner may execute them until a migration grants a role.
