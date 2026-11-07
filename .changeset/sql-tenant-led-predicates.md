---
"permdock": minor
---

`rls generate` writes the scope-key predicate as `"orgId" = any(array(select permdock.permitted_organization_ids('k')))` instead of `"orgId" in (select …)`, so Postgres reads the array once and uses the tenant index instead of a hashed SubPlan over a Seq Scan; `rls import` reads both forms. The custom-role probe compares `tenant_id` uncast and the custom-role tables gain `custom_role_permissions_probe_idx` and `custom_role_includes_probe_idx`. The closure refresh casts its id array to the id type, not the id column. The helper memo key uses the `session_id` claim instead of an md5 of the whole token. `subject_for` starts from the roles a user holds instead of unioning both custom-role tables. Re-run `permdock generate` and apply the diff.
