---
'permdock': minor
---

Approvals can go stale when the row changes. `resource(schema, { version: 'updatedAt' })` names the row field that changes with the row, and `approval: { staleOn: 'resource-change' }` hashes its value into the decision token (the prefix stays `pd1.`; tokens of grants without `staleOn` are unchanged). Resuming with a token that approved an earlier version of the same row denies with the new reason `stale-approval` and leaves the old record unconsumed; the next call without it is a new `approval-required`. `definePolicy` throws for `staleOn` on a collection action or on a resource without `version`. Approval requests carry `approvers.staleOn`, the catalog carries resource `version` and `staleOn` in `approvals`, and a hosted approval without `staleOn` is `weaker-approval` against a code allow that sets it.
