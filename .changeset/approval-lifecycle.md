---
'permdock': minor
'@permdock/testing': minor
---

An approval now resumes exactly one call ([ADR 0051](https://permdock.com/docs/decisions/0051-approval-lifecycle)).

- `ApprovalStore` gains `consume(token, now?)`, an atomic step that sets `consumedAt` on an approved request. `memoryApprovalStore` and `cloud().approvals` implement it; custom stores must add it, and until they do a resume is denied. A second resume is denied with `approval-consumed`. The decision endpoint inspects an approval without consuming it.
- A resume token applies only when the decision is `approval-required` and the token is that call's. A stale `PermDock-Approval` header no longer denies a call that needs no approval, and in a batch it no longer denies other items.
- Agent adapters (`ai-sdk`, `openai`, `claude-agent`, `eve`) read the resume token from `permdockApproval` on the context instead of `approval` or `token`.
- The approval token hashes only the principal's `id`, `tenant` and `issuer` and the actor's `id` and `kind`, so a session refresh keeps an outstanding approval valid. Approvals issued before the upgrade stop matching and expire within their TTL.
- Approvals with a tenant require an approver with a membership in that tenant, even without `approvers`. `approvalsHandler`'s inbox lists only the approver's tenants.
- `permdock/approvals` exports `ApprovalError`, `assertApprover`, `consumeApproval` and `resumeDecision`. `isApprovalError` matches by `name` and `code`.
- `memoryApprovalStore().expire()` drops settled records one TTL after their deadline.
- `cloud().approvals` reads v2 approval records; before, it returned `null` for every record PermDock created.
- `@permdock/testing`: `testApprovalStore(store, { reopen })` covers duplicate `create`, concurrent `consume`, cross-tenant resolve and resume after a restart.
