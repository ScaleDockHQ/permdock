---
"permdock": minor
---

`permdock rls`: `rls.seeds: 'function'` writes the seeds as `<schema>.seed()`; `rls explain` shows what a generate run binds to; `rls.customRoles.from.sync: 'trigger'` keeps copied custom roles current; a role column takes `{ column, map }`; `rls verify --kind pgtap` writes `supabase/tests/permdock_rls.test.sql` (or `--out`) and seeds fixture memberships; `rls migrate` and `rls import` require `pgsql-parser` 18. `supabase.hook.teams` adds a `team_ids` claim, and `parseCustomRoleEntry` checks one stored custom-role entry.
