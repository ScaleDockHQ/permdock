---
"permdock": minor
---

Approvals gain `approval: { fallback: "confirm" }` with `approverDirectory` on `approvalsHandler` and `resolveApproval`, which lets the principal approve while no other eligible approver exists. With `rls.approvals.managers`, the two-argument `permdock_is_approver` accepts `manager` approvers. `rls.approvals.tenantPolicies` takes `table`, `function`, `columns` and `path`, and `tableApprovalPolicySource` takes `function`. An adopted approvals table's token column carries the `@bsb identifier` tag.
