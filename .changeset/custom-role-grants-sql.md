---
"permdock": minor
---

`permdock rls generate --custom-roles` in `database` mode now emits `permdock_replace_custom_role_grants`, `permdock_rename_custom_role_grants` and `permdock_delete_custom_role_grants`. They save, rename and delete a custom role's rows with the rules of `validateCustomRole` and `assignablePermissions`, checked against the signed-in caller, so an application no longer hand-writes a `security definer` function for it.
