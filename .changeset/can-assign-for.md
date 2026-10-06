---
"permdock": minor
---

`database` mode adds `permdock_can_assign_for(p_user, p_role, p_scope_id)`, the `assigns` check of `permdock_can_assign` for a user the caller names, and, with `rls.assignments` and custom roles, `permdock_can_assign_custom_role_for(p_user, p_tenant, p_scope, p_scope_id, p_role)` over the new internal `permdock_custom_role_guard_for` and `permdock_custom_role_beyond_for`. Trusted SQL that acts later for a stored user, such as accepting an invitation, re-checks that the inviter may still assign the role. No client role may execute them. The custom-role form is written only where every scope has `member_<scope>_ids_for` (Supabase).
