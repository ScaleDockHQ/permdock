---
"permdock": minor
---

`decideCustomRole(permdock, role)` decides whether the subject may save a tenant or platform custom role: it runs `validateCustomRole` and denies with `not-assignable-by` any key or level outside `assignablePermissions` and `assignableLevels`, listed in `beyond`.
