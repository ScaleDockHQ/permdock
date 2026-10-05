---
"permdock": minor
---

`rls.customRoleWrites.roles` names the application's own table of custom roles (`table`, `key`, `tenant`, and optionally `scope`, `id` and a `skip` column for declared or system rows). `rls generate` then adds `permdock_cascade_custom_role()` and an `after update or delete` trigger on that table: a rename or a move to another tenant, scope or instance carries the role's grants and includes, and a delete removes them. A signed-in caller passes the same checks as the write functions where the role was and where it lands; migrations, jobs and nested triggers move the rows directly.
