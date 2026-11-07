---
"permdock": minor
---

`permitted_<resource>_rows` carries an arm that reads only the row inline, so its `permitted_<scope>_ids` calls run once per statement and not once per row. The tenant prefilter applies with custom roles and levels. A custom role is probed once per membership, and `permitted_<scope>_ids` reads its keys once per distinct set of entries. With `rls.seeds: 'view'`, the helpers read grant keys from `permdock_role_keys(scope, role)`. The token hook reads the roles, memberships, teams and `authz_ver` in one statement, and the budget counts `roles`, `memberships`, `team_ids`, `attrs` and `authz_ver`: a `supabase inspect` manifest marks `roles` and `authz_ver` as budget claims, and `budget.measure` lists them. Helper names and signatures do not change, so better-supabase 0.53 works as before.
