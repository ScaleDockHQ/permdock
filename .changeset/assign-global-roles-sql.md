---
"permdock": minor
---

`permdock_can_assign` now answers for global roles. A global role whose `assigns` lists another global role may assign it, and the check takes a null `p_scope_id` for that assignment. A scoped role is never assignable with a null instance, by a global assigner or anyone else. The `rls.assignments` triggers treat a row whose instance column is null as a global assignment: a declared role goes through `permdock_can_assign(role, null)` and a custom role through `permdock_can_assign_custom_role(null, 'global', null, role)`, the platform custom-role checks. One invitations table can now hold tenant and platform invitations. Regenerate the RLS output; a row with a null instance that names a scoped role is now refused.
