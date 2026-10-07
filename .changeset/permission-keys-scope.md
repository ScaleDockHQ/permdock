---
"permdock": minor
---

`permdock rls generate` adds `permdock_permission_keys(p_scope)` next to `permdock_permission_keys()`: the declared keys some declared role is allowed on that scope (`global` or a scope name), so a role editor at the organization lists only what an organization role can hold. The zero-argument form is unchanged.
