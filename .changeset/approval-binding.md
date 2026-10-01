---
'permdock': minor
---

Approval tokens bind the call's data when there is no row id: for a collection action, or a row without its `id` field, `Decision.token` includes a SHA-256 of the canonical JSON of the validated data, so an approved call no longer covers a retry with different arguments. `approval.by` refuses `relation()` at `definePolicy`, and an approval store refuses every approver for a stored request whose approvers include a relation. `permdock/terminal` prompts y/N only for a grant with `approval: { distinct: false }` and no actor; any other approval is recorded in the `store` and the command exits `75` until someone else approves it, or exits `77` when no `store` is configured. `storedApprovalToken` moved from the agent kernel to the approvals helpers.
