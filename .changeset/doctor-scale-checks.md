---
"permdock": minor
---

`permdock doctor` adds PD103 to PD111: a PermDock helper called per row in a policy, two permissive policies on one command, an unindexed `follows`, `via` or `walk` column, a `::text` cast on a key, an unsargable custom-role probe, `permitted_*_rows(p)` without a tenant, `rls.customRoles` in `jwt` mode (error), an access token over 4,096 characters (with `--db-url-stdin`) and an optional `limit` on a list endpoint. `--only performance` runs them. `permdock rls verify --advisors` also runs `supabase db advisors --type performance` and maps `multiple_permissive_policies` to PD104 and `unindexed_foreign_keys` to PD105.
