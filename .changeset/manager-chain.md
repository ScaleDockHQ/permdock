---
"permdock": minor
---

`rls.approvals.managers` takes a self-referencing table, `{ table, id, reportsTo, user, tenant, active? }`, and adds `permdock_manages_row`, `permdock_managed_row_ids_in`, `permdock_managed_row_ids`, `permdock_accessible_row_ids` and `permdock_request_approver_ids`; `authorizationProvider` fills `approverFor` from the last. `permdock codemod manager-chain` rewrites hand-written walks to them.
