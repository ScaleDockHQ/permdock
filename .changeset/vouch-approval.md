---
"permdock": minor
---

`vouchApproval(store, token, { status, by, rule, note? })` in `permdock/approvals` records a verdict that the application's own approval rules decided, such as a manager chain, delegates or a quorum it counts itself. The store resolves the request at once and records `vouched: rule` on the request and on the approval, so the audit trail says which rule decided. The eligibility checks of `approvers`, the tenant membership and the quorum are skipped; the actor, the principal (unless `distinct: false`), a repeated approver, an unauthenticated subject and a closed or expired request are still refused. `ApprovalVerdict.vouched` is server-side input that `approvalsHandler` never reads from a body. `applyApprovalVerdict` handles it, so the memory store, the generated Supabase store and custom stores built on it support it, and `testApprovalStore` checks it. The approval request wire format (`v: 1`) gains the optional `vouched` field.
