---
"permdock": patch
---

`createPermDock` now calls `RoleSource.globalRoles` with `{ held }`, the global role names the subject holds, and `customRoleSource(reader, { read: 'held', policy })` skips the platform read while every one of them is a declared role, as it already did for a tenant's roles. A request from a subject with only declared global roles no longer reads platform custom roles. Sources that ignore the argument are unaffected.
