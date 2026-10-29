---
name: permdock-approvals
description: Requires human approval on PermDock grants, notifies approvers and resumes the approved call. Use when adding approval to a destructive or money-moving action (delete, publish, pay, refund, transfer), choosing approvers with approval by, user(), relation(), mode confirm or authorize, quorum, ttl, escalation or staleOn, ordering approvers with combine and stages, covering an approver with an ApprovalDelegation, loading approval rules as data with an ApprovalPolicySource, separating preparer and approver with exclusiveWith, labelling operations with risk and effects meta, mounting approvalsHandler with an ApprovalStore, sending approval emails (approvalEmail) or chat cards (approvalCard, approvalActions) from approvalPrompt, parking a background run on an ApprovalWaiter (pollingApprovalWaiter, workflowSdkWaiter), resuming with the PermDock-Approval header, mapping approval-required to an agent runtime, MCP elicitation or AG-UI interrupt, or fixing doctor PD017, PD018 or PD024.
license: MIT
metadata:
  author: ScaleDockHQ
  homepage: https://permdock.com/docs/security/approvals
  repository: https://github.com/ScaleDockHQ/permdock
---

# PermDock approvals

`approval-required` is the third outcome: the subject may do it, but a person other than the requester confirms each call. An approval never grants something the subject could not do, and a `deny` still wins ([approval security](https://permdock.com/docs/security/approvals)). Set up the policy and factory first with the `permdock-wire` skill (`npx skills add ScaleDockHQ/PermDock --skill permdock-wire`).

## Inputs (find out, or ask before starting)

- Which actions need a person: deletions, publishing, payments, refunds, access changes, anything an agent can repeat.
- Who may approve each one (a role, a plan, `assurance()`, one named user, or a relation on the row such as the expense's manager), how many approvers (quorum), whether several groups sign in order, how long an ask may wait, and who steps in when nobody answers.
- Whether organisations configure their own approval rules at runtime ("payments over 1000 need finance").
- Whether the approver judges the row's content (an amount, a text), so a changed row needs a new approval.
- Whether a user confirming their own agent's call is the intent anywhere.
- Where pending requests live: one process (`memoryApprovalStore`), the app's database, or PermDock Cloud.
- Which runtimes ask: HTTP, AI SDK, Claude Agent SDK, Eve, OpenAI Agents SDK, MCP, A2A, WebMCP, a chat UI, or a background run (workflow, queue) that must wait.
- How approvers hear about a request (email, chat, the app's inbox only) and where the app's approval page lives.

## Invariants

1. The requester never approves by default. The actor is always refused. The principal is refused unless the grant sets `mode: "confirm"`, and `requireDistinctApprover` on the handler refuses it even then. A delegate is held to the same rule, and so is the delegator. One hop, and `until` is required.
2. The approver comes from authentication on the approval surface, never from the request body, a tool argument or a link.
3. One approval resumes one call. The token binds permission, resource, subject and actor, the resume re-runs `decide`, and `consume` spends the approval once.
4. `can` returns `false` for `approval-required`. Only `decide`, `assert` and the adapters see the third outcome.
5. Quorum, ttl and escalation live on the grant, not in the store. A grant's `ttl` can shorten the store's window, never extend it.
6. A `relation()` approver is matched only through facts the approvals handler reads from the app's `RelationSource` at verdict time, never from a request body.
7. Approval rules kept as data only add stages. A source that fails to load denies every call an allow would grant.
8. A link never approves. An email or chat prompt carries the request id, never the token, and links to the app's approval page where the approver signs in. Chat buttons carry the request id and are applied as the platform-verified clicking user.
9. A wake carries no verdict. `waiter.wake(token)` only ends a wait; the run decides again through `resumeApproval`, which reads the store.
10. PermDock never decides on operation `meta`. `risk` and `effects` label or gate a call in the host; only the grant's `approval` asks a person.

## Workflow

1. **Mark the grants.** Add `approval: 'human'` (anyone authenticated but the requester) or `approval: { by }` with the same selectors as `to`:

   ```ts
   allow(permissions.payout.release, {
     approval: {
       by: roles.finance,
       quorum: 2,
       ttl: 1800, // seconds: 30 minutes
       escalation: { after: 14_400, to: roles.owner }, // 4 hours
     },
   });
   ```

   For sign-off in order, use `combine: 'sequential'` with `stages: [{ by, quorum? }]` (or `combine: 'all'` for any order); one person signs one stage. `user('u_cfo')` names one person, and `relation(permissions.expense, 'manager')` names whoever holds the relation on the row.
   Add `mode: "confirm"` only where the user confirms their own agent's call and no money, deletion or access change sits behind it.
   ✓ `permdock doctor` reports no PD017 (sensitive verb without approval), and every PD024 (`mode: "confirm"`) is deliberate.

2. **Bind content when it matters.** Declare `version: 'updatedAt'` (or a revision counter) on the `resource()` and add `staleOn: 'resource-change'` to the approval, so a changed row resumes as `stale-approval` and asks again.
   ✓ `definePolicy` accepts the grant (it throws when the resource has no `version` or the action is a collection action).
3. **Split workflow verbs.** Model `prepare`, `approve`, `pay`, `settle` and `submit` as separate leaves. Put the approval on `approve` / `pay`, and use `exclusiveWith` on `role()` so a preparer cannot also hold the approver role.
   ✓ `permdock doctor` reports no PD018 (exclusive roles held together).
4. **Label risk.** Give each approval-gated operation in `defineOperations` a `meta` with `title`, `risk` (`low`, `medium`, `high`, `critical`) and `effects` (`read`, `write`, `delete`, `send`, `spend`, `external`), so prompts and the host's UI show what the call does ([operations](https://permdock.com/docs/concepts/operations)). -> [references/delivery-and-waiters.md](references/delivery-and-waiters.md#risk-meta)
   ✓ `defineOperations` builds the map without throwing, and every `risk: 'high'` or `'critical'` operation's permission has an `approval` grant.
5. **Store and handler.** Create one `ApprovalStore`, pass it as `store` to every adapter, and mount `approvalsHandler(store, { subject })` for approvers (`GET /:id`, `POST /:id/approve` and `/reject` with `If-Match`); add `relations` and `permissions` when a grant uses `relation()` approvers. -> [references/stores-and-resume.md](references/stores-and-resume.md)
   ✓ A second authenticated user can approve; the actor and the requester get `403`, and a stale `If-Match` gets `412`.
6. **Rules as data (optional).** Pass `approvalPolicies` (an `ApprovalPolicySource`, `memoryApprovalPolicySource` in process) to `createPermDock` for approval rules organisations configure. -> [references/stores-and-resume.md](references/stores-and-resume.md#approval-policies-as-data)
   ✓ `testApprovalPolicySource` from `permdock/testing` passes on the source.
7. **Notify approvers.** Build the prompt with `approvalPrompt(request, { operation })` and send it with `createPermDock` from `permdock/delivery`: `approvalEmail` from `permdock/resend` for email, a chat message with `approval` (rendered as `approvalCard`) plus `approvalActions` from `permdock/chat-sdk` for chat ([delivery](https://permdock.com/docs/concepts/delivery)). -> [references/delivery-and-waiters.md](references/delivery-and-waiters.md#approval-prompts)
   ✓ The `DeliveryReport` shows `sent` for each eligible approver and none for the requester; the message holds no token and no approve link.
8. **Surface and resume.** Map the outcome to each runtime's approval hook and resume with the token: the `PermDock-Approval` header over HTTP, the runtime's own resume for agents. -> [references/stores-and-resume.md](references/stores-and-resume.md#surfaces)
   ✓ The approved call runs once; a second resume is denied with `approval-consumed`.
9. **Wait in background runs.** Pass a `waiter` to `createPermDock` from `permdock/workflow` (`pollingApprovalWaiter({ store, interval })`, or `workflowSdkWaiter` from `permdock/workflow-sdk`) and call `awaitApproval`, or `openApproval` and `resumeApproval` as steps. The approver's endpoint calls `waiter.wake(token)` after `resolveApproval` ([automations](https://permdock.com/docs/concepts/automations)). -> [references/delivery-and-waiters.md](references/delivery-and-waiters.md#waiters)
   ✓ A wake before any verdict leaves the run denied with reason `approval`; a wake after approval lets it proceed once.
10. **Test.** Add a scenario test per approval grant: the ask, an approval by an eligible user, a refused self-approval, and the single resume ([scenario testing](https://permdock.com/docs/guides/scenario-testing)). Run `testApprovalStore` on a custom store.
    ✓ The tests pass.

## Verify before done

- [ ] Every destructive or money-moving action an agent or a user can trigger has `approval`, or a `deny` on the same leaf.
- [ ] Each `mode: "confirm"` (PD024) is a deliberate self-confirmation with nothing irreversible behind it.
- [ ] Roles that must not be held together set `exclusiveWith`, and PD018 is clean.
- [ ] The store survives the deployment: no `memoryApprovalStore` on serverless or across replicas.
- [ ] No resume token is read from model output or tool arguments, and each resume re-runs `decide`.
- [ ] A custom `ApprovalStore` passes `testApprovalStore` from `permdock/testing`.
- [ ] Grants with `relation()` approvers have a handler with `relations`, and nothing fills `verdict.relations` from client input.
- [ ] No email, chat message or URL carries the approval token or an approve link; `approvalUrl` is https and opens a page behind sign-in.
- [ ] Approval recipients are decided by `deliver` from server-loaded principals, never from the request body, and the requester is not among them.
- [ ] Chat approve and reject clicks go through `approvalActions` (or `resolveAction`), never a handler that trusts the button value alone.
- [ ] Every approver endpoint that resolves a request for a parked run calls `waiter.wake(token)` after `resolveApproval`, and no run reads a verdict from a wake, hook payload or queue message.
- [ ] No code grants, skips or auto-approves a call because of `meta.risk` or `meta.effects`.

## Reference index

- [references/stores-and-resume.md](references/stores-and-resume.md): `approvalsHandler` routes and preconditions, custom stores, relation approvers, approval policies as data, the token and its CloudEvents, resume details and denial causes, the runtime surfaces table.
- [references/delivery-and-waiters.md](references/delivery-and-waiters.md): operation risk meta, `approvalPrompt` with `permdock/delivery`, `approvalEmail`, `approvalCard` and `approvalActions`, `ApprovalWaiter`, `pollingApprovalWaiter`, `workflowSdkWaiter`, `cloudApprovalWaiter`.
- Docs: [approval security](https://permdock.com/docs/security/approvals), [approvals adapter](https://permdock.com/docs/adapters/approvals), [delivery](https://permdock.com/docs/concepts/delivery), [Resend](https://permdock.com/docs/adapters/resend), [Chat SDK](https://permdock.com/docs/adapters/chat-sdk), [automations](https://permdock.com/docs/concepts/automations), [Workflow SDK](https://permdock.com/docs/adapters/workflow-sdk), [operations](https://permdock.com/docs/concepts/operations), [wire formats](https://permdock.com/docs/concepts/wire-formats).
