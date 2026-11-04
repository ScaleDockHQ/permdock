---
"permdock": minor
---

Add `permdock/react/lite`: `PermDockProvider`, `usePermission` and `Protected` that answer type-level checks from the list `permdock.grantedPermissions()` returns. It imports React only and measures 282 B gzip against 20,263 B for `permdock/react`; a permission outside the list, and any check without a provider, is denied.
