---
"permdock": patch
---

`cloud().approvals.resolve` throws the `ApprovalError` code and message the Cloud sends, such as `approver-not-eligible`. It used to report every refusal other than `409` and `410` as `approval-not-found`.
