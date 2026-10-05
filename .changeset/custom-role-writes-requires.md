---
"permdock": minor
---

`rls.customRoleWrites.requires` makes the generated custom-role write functions check that the caller may manage roles before any hand-out check: it names permission keys, or `'manageRoles'` for every permission with `meta.manageRoles`. A caller holding none of them in the tenant, or through a global role, gets `42501` with hint `manage-roles` from `permdock_replace_custom_role_grants`, `permdock_rename_custom_role_grants` and `permdock_delete_custom_role_grants`.
