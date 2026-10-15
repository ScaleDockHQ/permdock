# Risk meta, approval prompts and waiters

A pending request needs three things around it: a label saying how risky the call is, a prompt that reaches the approvers, and, for a background run, a way to park until someone answers. None of them decides anything: the verdict comes from `approvalsHandler` (or `resolveApproval`) and the resume re-runs `decide`.

## Risk meta

`defineOperations` from `permdock` binds each action to one permission leaf and carries `meta` `{ risk?, effects?, title? }` ([operations](https://permdock.com/docs/concepts/operations)):

```ts
import { defineOperations } from "permdock";

export const operations = defineOperations(permissions, {
  "invoice.pay": {
    permission: permissions.invoice.pay,
    data: (input: { id: string }) => invoices.get(input.id),
    meta: {
      title: "Pay an invoice",
      risk: "high",
      effects: ["spend", "external"],
    },
  },
});
```

- `risk` is one of `low`, `medium`, `high`, `critical`. `effects` lists distinct values of `read`, `write`, `delete`, `send`, `spend`, `external`. Any other value throws when the map is built.
- PermDock never decides on `meta`. The approval comes from the grant's `approval`; `meta` is what a host reads to label, confirm or gate a call (a red badge, a confirmation dialog, a rule in your own UI).
- Do not use `risk: 'high'` instead of `approval` on the grant. A label without a grant asks nobody.
- `approvalPrompt(request, { operation })` copies the operation's `name`, `title`, `risk` and `effects` into the prompt, so emails and cards show them.

## Approval prompts

`permdock/delivery` sends a message only to recipients the policy grants, and `approvalPrompt` turns a pending request into what an approver sees ([delivery](https://permdock.com/docs/concepts/delivery)).

```ts
import { whoCan } from "permdock";
import { requestApproval } from "permdock/approvals";
import { approvalPrompt, audience, createPermDock } from "permdock/delivery";
import { approvalEmail, resendTransport } from "permdock/resend";

const delivery = createPermDock(policy, {
  transports: {
    email: resendTransport(resend, { from: "Acme <billing@acme.test>" }),
  },
  principals, // PrincipalSource: links addresses to principals
  sink,
});

const request = await requestApproval(store, decision, {
  permission: permissions.invoice.pay,
  resource: { type: "invoice", id: invoice.id },
  subject: permdock.subject,
  detail: `Pay invoice ${invoice.id}`,
});
const holders = await whoCan(permdock, permissions.invoice.pay, invoice);
const approvers = await audience(permdock, permissions.invoice.read, invoice, {
  candidates: holders.holders
    .map((holder) => holder.principal.id)
    .filter((id) => id !== permdock.subject.principal?.id),
});
const prompt = approvalPrompt(request, {
  operation: operations["invoice.pay"],
});
await delivery.deliver(
  permdock,
  permissions.invoice.read, // a permission every approver holds on the row
  invoice,
  approvers.principals.map((id) => ({
    principal: id,
    channel: "email",
    address: emailOf(id),
  })),
  {
    email: approvalEmail(prompt, {
      approvalUrl: "https://app.acme.test/approvals",
    }),
  },
  { approval: prompt.id },
);
```

- `approvalPrompt` throws a `TypeError` for a request that is not pending. The prompt (`ApprovalPrompt` v1) carries the request `id`, permission, scope, resource, requester, tenant, detail, `createdAt`, `expiresAt` and the operation; it never carries the approval token, roles or memberships.
- `approvalUrl` is an https base the encoded request id is appended to, or a function of the prompt. Anything but https throws. The page it opens is the app's own approval screen, behind sign-in, that calls `approvalsHandler` (`GET /:id`, then `POST /:id/approve` or `/reject`).
- `deliver` decides every recipient with `decideFor` and never rejects: a refused, unlinked or malformed recipient is a `failed` delivery event. Pass `{ approval: prompt.id }` so every event names the request.
- Recipients come from the server: a `principal` id with the address the server loaded for it, or an address that `principals.principalByIdentity` links. Never take recipients from the request body.

### Email

`approvalEmail(prompt, { approvalUrl, product? })` from `permdock/resend` returns an `EmailMessage` with category `approval`. The subject is `Approval needed: <title>`; the body names the requester, the permission and resource, the risk and the expiry, and has one link to the approval page. It has no approve or reject link. Send it with `resendTransport`, or with your own `EmailTransport` for another provider. `resendWebhook` turns Resend bounces and complaints into delivery events ([Resend adapter](https://permdock.com/docs/adapters/resend)).

### Chat

`permdock/chat-sdk` renders and applies approval cards on the Chat SDK ([Chat SDK adapter](https://permdock.com/docs/adapters/chat-sdk)):

```ts
import { createPermDock } from "permdock/chat";
import { approvalActions, chatSdkTransport } from "permdock/chat-sdk";

const chatPermDock = createPermDock(policy, {
  principals,
  memberships,
  approvals: store,
});
const actions = approvalActions(chatPermDock, { workspace: "T0ACME" });
chat.onAction([...actions.actionIds], actions.onAction);

// a chat message with `approval` is posted as `approvalCard`
await delivery.deliver(
  permdock,
  permissions.invoice.read,
  invoice,
  recipients,
  {
    chat: {
      text: prompt.detail,
      approval: { prompt, url: "https://app.acme.test/approvals" },
    },
  },
  { approval: prompt.id },
);
```

- `approvalCard(prompt, { approvalUrl, buttons? })` shows the detail, requester, permission, resource, risk and expiry, a Review link, and Approve and Reject buttons whose `value` is the request id, never the token. `buttons: false` leaves only the link.
- `approvalActions` resolves the clicking user from the platform's signed event through `ChatPermDock.resolveAction`. A click from an unlinked user, the requester or a bot records nothing.

### Rules

- A link never approves. A forwarded email, a link scanner or a preview bot can open it; the approval page asks the approver to sign in and decides as that session's subject.
- Buttons are allowed in chat only because the platform signs the click and names the user. Never put approve or reject links, or the token, in an email.

## Waiters

A background run (a workflow, a queue consumer) cannot hold an HTTP request open while it waits. `createPermDock` from `permdock/workflow` takes a `waiter` (`ApprovalWaiter`) next to `approvals` ([automations](https://permdock.com/docs/concepts/automations)):

```ts
import { createPermDock, pollingApprovalWaiter } from "permdock/workflow";

const workflow = createPermDock(policy, {
  signer,
  verifier,
  principals,
  automations,
  approvals: store,
  waiter: pollingApprovalWaiter({ store, interval: 5_000 }),
  sink,
});

const decision = await workflow.awaitApproval(
  ticket,
  permissions.invoice.send,
  invoice,
);
```

- `ApprovalWaiter` is `{ wait(token, { expiresAt?, signal? }), wake(token) }`. `wait` resolves when the request leaves `pending`, is woken or expires; it never says how it was decided.
- `awaitApproval(ticket, permission, row)` opens the request, waits, rebuilds the run and decides again. Runners that wait outside the call use the halves: `openApproval` before the wait and `resumeApproval(ticket, permission, token, row)` after it. A request still pending denies with reason `approval`.
- `pollingApprovalWaiter({ store, interval })` reads the store every `interval` milliseconds (default 5,000); `wake` ends a wait in the same process at once.
- `workflowSdkWaiter({ createHook, resumeHook, sleep? })` from `permdock/workflow-sdk` parks a Workflow SDK run on the hook `approvalHookToken(token)`. Call `wait` inside the `"use workflow"` function and `openApproval` / `resumeApproval` as steps ([Workflow SDK adapter](https://permdock.com/docs/adapters/workflow-sdk)).
- `cloudApprovalWaiter` from `permdock/cloud` wakes waits from PermDock Cloud's `com.permdock.approval.resolved`, `.expired` and `.cancelled` webhooks ([Cloud adapter](https://permdock.com/docs/adapters/cloud)).

The approver's endpoint wakes the run after it records the verdict:

```ts
import { resolveApproval } from "permdock/approvals";

await resolveApproval(store, token, {
  status: "approved",
  by: approverFromSession(request),
});
await waiter.wake(token);
```

A wake carries no verdict. Anyone holding a Workflow SDK hook token can resume it, so the step after the wait reads the store through `resumeApproval`; a forged wake finds the request still pending and denies. Never pass the verdict through the hook payload or the queue message.
