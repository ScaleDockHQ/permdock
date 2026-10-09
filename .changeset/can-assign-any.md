---
"permdock": minor
---

`permdock rls generate` writes `permdock_can_assign_any(p_role, p_tenant, p_scope, p_scope_id)` and, in `database` mode, `permdock_can_assign_any_for(p_user, ...)` whenever a role declares `assigns`: one check for a declared or a custom role. `permdock_can_assign_custom_role` is now written with custom roles in `database` mode whether or not `rls.assignments` is set. The `permdock.manifest.json` written by `permdock supabase inspect` lists the `_for` helpers and the assignment checks in `rls.helpers`, and adds `rls.customRoles`, `rls.roles`, `rls.suspension` and `rls.assignments`, so a package writing SQL next to the helpers can call them without reading PermDock's config. Regenerate the manifest with `permdock supabase inspect --out`.
