---
"permdock": patch
---

`permdock rls generate` and `permdock supabase hook generate` read global roles only from the rows without a tenant when `rls.roles` references a roles table through `through` and `rls.customRoleWrites.roles` names that table with a `tenant` column. `permdock_replace_global_roles` resolved keys over every row, so replacing a user's roles with `['dispatcher']` inserted one row per tenant role named `dispatcher` and kept rows that referenced a tenant role. It now resolves, keeps and inserts only global rows, and a key only tenant roles have raises `unknown-role`. `permdock_has` and the token hook no longer read a global-roles row that references a tenant role as a global role.
