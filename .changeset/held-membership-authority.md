---
'permdock': patch
---

Assign authority now comes from live, held memberships. Expired memberships no longer count toward `tenants()`, the active tenant, `assignableRoles()` or a credential's ceiling. `decideRoleChange` reads a nested change's tenant from the subject's membership and denies a disagreeing `within` with `no-membership`; pass `{ trusted: true }` when the application loaded `within` from its own store. `activate` copies `within` from the eligible membership, and the approval token covers it.
