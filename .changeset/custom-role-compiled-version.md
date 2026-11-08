---
"permdock": minor
---

`rls generate` compiles each stored custom role into `permdock.custom_role_compiled` from statement triggers, and the policies, `subject_for` and the probe read one indexed row per held role instead of calling `permdock_custom_keys`. A custom-role edit bumps `permdock.custom_role_version` once per tenant, the hook writes the active tenant's version as `custom_roles_ver`, and `custom_roles_version_for(p_tenant)` reads it. Run `select permdock.permdock_recompile_custom_roles()` once after upgrading: a role stored before has no compiled row and grants nothing until then. The custom-role writers match the stored role by `=` instead of `is not distinct from`, so a save no longer scans `custom_role_permissions`.
