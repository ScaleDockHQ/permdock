---
'permdock': patch
---

`supportAccess()` now type-checks inside `definePolicy({ roles })` when the policy's scopes are literal: it returns `RoleBinding<S>` for `on: S` and `RoleBinding<'tenant'>` without `on`, the scope it defaults to.
