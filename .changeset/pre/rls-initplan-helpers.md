---
'permdock': minor
---

`permdock rls generate` compiles role checks to per-statement helpers. Policies call `permdock_has('<grant key>')` for global roles and `"<tenant col>" in (select permitted_tenant_ids('<grant key>'))` (or `permitted_team_ids`) for scoped roles: `security definer`, `search_path = ''` SQL functions over a seeded `role_permissions (role, permission, grant_key, scope, effect)` table, which Postgres evaluates once per statement (an InitPlan or hashed SubPlan) instead of once per row. `--authorize database|jwt` now drives them for every dialect. Tenant grants with only a claim and global grants with no condition no longer skip the role check.

Policies collapse to one permissive and one restrictive policy per table and command (`{table}_{op}`); `--policy-per-role` keeps the per-role layout and `--policy-name` sets a template. The tenant claim is cast to `--tenant-type` (default `uuid`). Top-level `definePolicy({ grants })` compile too, and a grantee Postgres cannot see fails with the permission named. `--rbac supabase` builds on the same helpers; `authorizeSql` reads the shared `role_permissions`. `rls import` reads both layouts back to roles and `memberOf`, `rls verify` passes roles and memberships in the claims and inserts whole rows, and `rlsParity` sets the role and memberships GUCs.
