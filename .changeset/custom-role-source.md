---
"permdock": minor
---

`customRoleSource({ rolesOf, assignable?, globalRoles? }, { read? })` builds a `RoleSource` from a read of every custom role of a tenant, so `assignableRoles`, `assignablePermissions` and `decideRoleChange` see roles the subject does not hold. It keeps only the requested tenant's roles; `read: 'held'` with a `policy` skips the read when the subject holds only declared roles. `testRoleSource` takes `every`, the custom role names a tenant has, and fails a source that returns fewer with nothing held.
