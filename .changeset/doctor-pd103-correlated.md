---
"permdock": patch
---

Doctor PD103 also reports a policy that passes a column of its own row to a set helper (`permitted_<resource>_rows`, `_rows_for`, `_ids_in`, `_count`, `permitted_<scope>_permission_keys`), such as better-supabase's `permitted_<resource>_rows('key', array[id])`, which Postgres runs again for every row.

PD108 no longer reports a generated policy, accepts `permitted_<scope>_ids_by_permission` as a tenant lead, and stops suggesting `permitted_<resource>_rows(p, <tenant column>)`, which PD103 now reports.
