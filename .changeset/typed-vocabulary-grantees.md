---
'permdock': minor
'@permdock/cli': minor
'@permdock/testing': minor
---

Typed vocabulary (`defineRoles`, `definePlans`), `to:` grantee selectors, `principal` refs, `actions()`, and snapshot v3.

Breaking before 1.0: `Role` is now the vocabulary leaf (`RoleBinding` is the grant list); `roles()` / `assignable()` rename to `heldRoles()` / `assignableRoles()` and return `Role[]`; `Grant.role` becomes `Grant.to`; snapshots emit `v: 3`.
