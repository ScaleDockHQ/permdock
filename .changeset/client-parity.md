---
'permdock': minor
'@permdock/testing': minor
---

A snapshot client never grants what the server denies. Snapshots carry the policy's row keys (`scopes`) and one grant entry per membership, and the client checks the row's tenant and team and fails closed on closure denies. `where()` is scoped to the active tenant and honours unconditional denies. Custom roles expand only in their own tenant. Rows of a partitioned resource must carry the partition field. `heldRoles()` without a tenant returns global roles only. Quotas count per tenant, `per` is validated when the grant is defined, and `memoryLimitStore()` forgets ended windows. `@permdock/testing` adds `testClientParity` ([ADR 0050](https://permdock.com/docs/decisions/0050-client-parity-and-snapshot-scopes)).
