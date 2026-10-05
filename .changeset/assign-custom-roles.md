---
"permdock": minor
---

`assignableRoles()` now lists the tenant's custom roles from the `RoleSource` that the subject may hand out, and `decideRoleChange` assigns and revokes them instead of denying with `unknown-role`. A custom role qualifies when the subject may assign a declared role at its scope (or holds `meta.manageRoles`) and may hand out every permission and level it allows; it has no holder count and inherits `for` and `exclusiveWith` from its included roles. Declared roles behave as before.
