---
"permdock": patch
---

`assignableRoles()` no longer offers a custom role that allows nothing after the ceiling (empty, deny-only, or with every entry outside the ceiling or undeclared), and `decideRoleChange` denies assigning one with `not-assignable-by`. Revoking such a role stays granted for an actor who may assign at its scope.
