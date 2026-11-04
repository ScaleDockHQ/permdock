---
"permdock": minor
---

Add `omitAssignable` to `permdock.snapshot`, `snapshotFor`, `getSnapshot` and the Next.js provider. It leaves `assignable` out of the snapshot, which repeats every assignable role and permission per tenant and made a `tenants: "all"` snapshot for a member of ten organisations about 270 KB larger. Checks are unchanged; `assignableRoles` and `assignablePermissions` return nothing on a snapshot built this way.
