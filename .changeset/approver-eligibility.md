---
'permdock': minor
'@permdock/testing': minor
---

Widen `approval` on grants to `'human' | { by, distinct }`, bump `ApprovalRequest` to v2 with `approvers` and `subject.session`, and enforce eligibility in `ApprovalStore.resolve` (`approver-not-eligible`). Adds optional `ApprovalStore.cancel` and `cancelApprovals` (ADR 0047).
