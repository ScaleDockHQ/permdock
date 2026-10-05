---
"permdock": minor
---

`permdock.derive({ customRoles?, approvalPolicies?, relations? })` returns an instance for the same subject, active tenant, team, actor, delegation, sink and limits with the sources it names read again, so an app no longer rebuilds the instance from `createPermDock` to add a tenant's approval policies or every custom role of a tenant. It returns a promise only when a named source is asynchronous; a `fromSnapshot` instance returns itself, and `permdock/pdp` keeps its providers.
