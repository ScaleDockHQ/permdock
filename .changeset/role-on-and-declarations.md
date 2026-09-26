---
'permdock': patch
---

`role(leaf, grants, { on })` now scopes its grants by `on` instead of the leaf's own scope, so a resource-scoped role declared with `defineRoles` no longer silently becomes global. `definePermissions` and `mergePermissions` no longer expose internal symbol keys in their return types, so a package that exports a permission tree or policy can emit declarations (TS4023).

`principal.id` and the other well-known subject paths (`tenant`, `roles`, `memberships`, `assurance`, …) are typed without `undefined` under `noUncheckedIndexedAccess`, so `where: { ownerId: principal.id }` typechecks in strict apps.
