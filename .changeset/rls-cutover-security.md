---
"permdock": patch
---

Fix two `permdock rls generate` holes in database mode: the membership source helpers (`permitted_<scope>_ids`, `permdock_permission_keys` and their `_for` forms) now read a custom role's stored level, so `job.read@own` no longer widens to every row; and a tenant row of `rls.customRoleWrites.roles` named like a declared role (`owner`) reads as no role, with a `permdock_custom_role_name_guard` trigger that refuses it (`declared-role`, `name-taken`). New doctor check `PD072`.
