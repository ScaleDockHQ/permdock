---
"permdock": minor
---

`ApprovalPolicySource` entries can match an operation's risk and effects from its `meta` as well as a permission key. `permdock rls generate` with `rls.approvals` emits `permdock_is_approver(p_approvers jsonb, p_tenant text)` for row-level policies on approval views.
