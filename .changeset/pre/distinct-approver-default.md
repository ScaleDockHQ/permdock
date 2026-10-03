---
"permdock": minor
---

Approvals refuse the requester by default. `approval: 'human'` and `approval: { by }` now refuse the request's principal as approver as well as its actor (`approver-is-principal`), in `assertApprover`, `ApprovalStore.resolve`, `resolveApproval` and `approvalsHandler`. A grant that wants the user to confirm their own agent's call opts out with `approval: { distinct: false }`, and `permdock doctor` PD024 (`--only self-approval`) warns on each opt-out. `requireDistinctApprover` stays as a handler-wide floor that refuses the principal even on an opted-out grant. A hosted grant that sets `distinct: false` on a permission a code allow guards with an approval is dropped as `weaker-approval`. `testApprovalStore` checks that a custom store refuses the principal on every approval shape and accepts it only with `distinct: false`.

Behaviour change: an approval request without `approvers.distinct` now refuses its principal. Set `distinct: false` on the grant to keep the old behaviour.
