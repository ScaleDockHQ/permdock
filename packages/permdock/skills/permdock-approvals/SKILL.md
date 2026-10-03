---
name: permdock-approvals
description: Requires human approval on PermDock grants and resumes the approved call. Use when adding approval to a destructive or money-moving action (delete, publish, pay, refund, approve, transfer), choosing approvers with approval by, distinct, quorum, ttl, escalation or staleOn, separating preparer and approver with exclusiveWith, mounting approvalsHandler with an ApprovalStore, resuming with the PermDock-Approval header, mapping approval-required to an agent runtime, MCP elicitation or AG-UI interrupt, or fixing doctor PD017, PD018 or PD024.
license: MIT
metadata:
  author: ScaleDockHQ
  homepage: https://permdock.dev/docs/security/approvals
  repository: https://github.com/ScaleDockHQ/permdock
---

# PermDock approvals

`approval-required` is the third outcome: the subject may do it, but a person other than the requester confirms each call. An approval never grants something the subject could not do, and a `deny` still wins ([approval security](https://permdock.dev/docs/security/approvals)). Set up the policy and factory first with the `permdock-wire` skill (`npx skills add ScaleDockHQ/PermDock --skill permdock-wire`).

## Inputs (find out, or ask before starting)

- Which actions need a person: deletions, publishing, payments, refunds, access changes, anything an agent can repeat.
- Who may approve each one (a role, a plan, `assurance()`), how many approvers (quorum), how long an ask may wait, and who steps in when nobody answers.
- Whether the approver judges the row's content (an amount, a text), so a changed row needs a new approval.
- Whether a user confirming their own agent's call is the intent anywhere.
- Where pending requests live: one process (`memoryApprovalStore`), the app's database, or PermDock Cloud.
- Which runtimes ask: HTTP, AI SDK, Claude Agent SDK, Eve, OpenAI Agents SDK, MCP, A2A, WebMCP, a chat UI.

## Invariants

1. The requester never approves by default. The actor is always refused. The principal is refused unless the grant sets `distinct: false`, and `requireDistinctApprover` on the handler refuses it even then.
2. The approver comes from authentication on the approval surface, never from the request body, a tool argument or a link.
3. One approval resumes one call. The token binds permission, resource, subject and actor, the resume re-runs `decide`, and `consume` spends the approval once.
4. `can` returns `false` for `approval-required`. Only `decide`, `assert` and the adapters see the third outcome.
5. Quorum, ttl and escalation live on the grant, not in the store. A grant's `ttl` can shorten the store's window, never extend it.
6. `relation()` is refused in `approval.by` and `escalation.to`.

## Workflow

1. **Mark the grants.** Add `approval: 'human'` (anyone authenticated but the requester) or `approval: { by }` with the same selectors as `to`:

   ```ts
   allow(permissions.payout.release, {
     approval: {
       by: roles.finance,
       quorum: 2,
       ttl: "30m",
       escalation: { after: "4h", to: roles.owner },
     },
   });
   ```

   Add `distinct: false` only where the user confirms their own agent's call and no money, deletion or access change sits behind it.
   ✓ `permdock doctor` reports no PD017 (sensitive verb without approval), and every PD024 (`distinct: false`) is deliberate.

2. **Bind content when it matters.** Declare `version: 'updatedAt'` (or a revision counter) on the `resource()` and add `staleOn: 'resource-change'` to the approval, so a changed row resumes as `stale-approval` and asks again.
   ✓ `definePolicy` accepts the grant (it throws when the resource has no `version` or the action is a collection action).
3. **Split workflow verbs.** Model `prepare`, `approve`, `pay`, `settle` and `submit` as separate leaves. Put the approval on `approve` / `pay`, and use `exclusiveWith` on `role()` so a preparer cannot also hold the approver role.
   ✓ `permdock doctor` reports no PD018 (exclusive roles held together).
4. **Store and handler.** Create one `ApprovalStore`, pass it as `store` to every adapter, and mount `approvalsHandler(store, { subject })` for approvers. -> [references/stores-and-resume.md](references/stores-and-resume.md)
   ✓ A second authenticated user can approve; the actor and the requester get `403`.
5. **Surface and resume.** Map the outcome to each runtime's approval hook and resume with the token: the `PermDock-Approval` header over HTTP, the runtime's own resume for agents. -> [references/stores-and-resume.md](references/stores-and-resume.md#surfaces)
   ✓ The approved call runs once; a second resume is denied with `approval-consumed`.
6. **Test.** Add a scenario test per approval grant: the ask, an approval by an eligible user, a refused self-approval, and the single resume ([scenario testing](https://permdock.dev/docs/guides/scenario-testing)). Run `testApprovalStore` on a custom store.
   ✓ The tests pass.

## Verify before done

- [ ] Every destructive or money-moving action an agent or a user can trigger has `approval`, or a `deny` on the same leaf.
- [ ] Each `distinct: false` (PD024) is a deliberate self-confirmation with nothing irreversible behind it.
- [ ] Roles that must not be held together set `exclusiveWith`, and PD018 is clean.
- [ ] The store survives the deployment: no `memoryApprovalStore` on serverless or across replicas.
- [ ] No resume token is read from model output or tool arguments, and each resume re-runs `decide`.
- [ ] A custom `ApprovalStore` passes `testApprovalStore` from `permdock/testing`.

## Reference index

- [references/stores-and-resume.md](references/stores-and-resume.md): `approvalsHandler` routes, custom stores, the token, resume details and denial causes, the runtime surfaces table, delivery to chat and email.
- Docs: [approval security](https://permdock.dev/docs/security/approvals), [approvals adapter](https://permdock.dev/docs/adapters/approvals), [wire formats](https://permdock.dev/docs/concepts/wire-formats).
