---
"permdock": patch
---

A snapshot instance's `can()`, `filter()` and `pick()` skip the decision token and the deep freeze, and the UI stores reuse a local decision for the rest of one render pass. `useTenant`, `useMemberships`, `useRoles`, `useAssignableRoles`, `useAssignablePermissions` and `useSubject` return the same object until the store changes.
