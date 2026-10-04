---
"permdock": patch
---

Approvals take `mode: 'all' | 'sequential'` with `stages: [{ by, quorum? }]`, `user(id)` approvers, and `relation()` approvers checked at verdict time through `approvalsHandler`'s new `relations` option (`approverRelations` in `permdock/approvals`). The approval request carries `mode` and `stages`, each signature its `stage`, and the verdict `relations`. `createPermDock` takes `approvalPolicies`, an `ApprovalPolicySource` (`memoryApprovalPolicies`) whose entries add approval stages to matching allows and deny with `approval-policy-unavailable` when they fail to load; `testApprovalPolicySource` checks a source.
