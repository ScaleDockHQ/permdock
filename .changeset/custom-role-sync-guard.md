---
"permdock": patch
---

Security: with `rls.customRoles.from.sync: 'trigger'`, a signed-in caller who wrote the application's role tables could hand out a permission they lack, including on a role they hold. `permdock rls generate` now adds `permdock_sync_custom_role_guard_<table>` before-row triggers that hold such a write to the checks of `permdock_replace_custom_role_grants` (`not-member`, `manage-roles`, `not-assignable-by`) against the copy as it stood before the statement. Regenerate and apply the helpers.
