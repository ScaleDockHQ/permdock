---
"permdock": patch
---

With `rls.customRoleWrites.roles.skip` set, `permdock rls generate` writes `permdock_custom_role_system_guard`, which refuses a signed-in caller that marks a role row as a system role or renames or moves one (`system-role`). Before, the name guard trusted the flag, so a tenant who could edit role rows could mark a custom role it holds as a system role and rename it to `owner`. Rerun `permdock rls generate`.
