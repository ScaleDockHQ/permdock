---
"permdock": minor
---

`permdock rls generate` writes `permdock_role_in(p_role, p_tenant)` with `rls.customRoles` in `database` mode: whether a role is declared or a custom role of the tenant (or one with no tenant), read from the `rls.customRoleWrites.roles` table or else the custom-role tables. Only trusted SQL may execute it, and `permdock supabase inspect` lists it in `rls.helpers`. Regenerate the helpers and the manifest to pick it up.
