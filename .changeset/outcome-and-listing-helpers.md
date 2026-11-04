---
"permdock": minor
---

Add `accessOutcome(decision)`, which reduces a decision to `granted`, `approval-required`, `anonymous`, `no-tenant`, `no-membership` or `denied`; `permdock.memberships({ via, scope })`; `permdock.grantedPermissions({ tenant, scope, id })`, which lists the permissions a rowless check grants; and `isGlobalPermission(policy, permission)`.
