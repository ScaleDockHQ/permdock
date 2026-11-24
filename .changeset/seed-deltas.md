---
"permdock": minor
---

`rls generate --seeds-out <dir>` writes only the `role_permissions` rows that changed since the newest seeds migration, stamped at the later of now and one second past the newest migration. Doctor `PD135` suggests `rls.seeds: 'view'` for a pg-delta project.
