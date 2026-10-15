# Operations, automations and chat

One operation table feeds agent tools, automations and chat commands. `permdock/agent`, `permdock/workflow` and `permdock/chat` are the runtime-neutral contracts; `permdock/ai-sdk`, `permdock/openai`, `permdock/claude-agent`, `permdock/eve`, `permdock/workflow-sdk` and `permdock/chat-sdk` implement them for one runtime.

## Operations: `defineOperations` from `permdock`

```ts
import { defineOperations } from "permdock";

export const operations = defineOperations(permissions, {
  send_invoice: {
    permission: permissions.billing.invoice.submit,
    data: (input: { id: string }) => db.invoice.find(input.id),
    meta: {
      risk: "high",
      effects: ["send", "external"],
      title: "Send invoice",
    },
  },
  list_invoices: {
    permission: permissions.billing.invoice.read,
    results: permissions.billing.invoice.read,
  },
});
```

It returns a frozen `OperationMap`; each entry is a frozen `Operation` `{ name, permission, data?, results?, meta }`.

| Field        | Meaning                                                                       |
| ------------ | ----------------------------------------------------------------------------- |
| `permission` | The leaf a caller must hold to run the operation                              |
| `data`       | Loads the row the check runs on from the input                                |
| `results`    | The leaf each result row is filtered by                                       |
| `meta`       | `{ risk?, effects?, title? }`, `{}` when absent; PermDock never decides on it |

- `risk` is one of `low`, `medium`, `high`, `critical`. `effects` lists distinct values of `read`, `write`, `delete`, `send`, `spend`, `external`.
- A name is 1 to 128 of `A-Z a-z 0-9 _ . -` (the MCP tool-name characters), so it works as a tool name unchanged. Names that differ only in case throw.
- `defineOperations` also throws for a `permission` or `results` outside `permissions` and for a `data` that is not a function.
- The row `data` returns is validated against the resource schema like any request-derived data. Parse the input before loading.
- With `operations: "./src/operations.ts"` in `permdock.config.ts`, `permdock collect` writes the map to the catalog, and doctor PD067 reports a key the permissions module does not declare.

Every agent adapter takes this map as `operations` ([operations](https://permdock.com/docs/concepts/operations)).

## Agent contract: `permdock/agent`

`permdock/ai-sdk`, `permdock/openai`, `permdock/claude-agent` and `permdock/eve` build on this contract and return its members next to their runtime hooks. Use `permdock/agent` directly for a runtime PermDock has no adapter for.

```ts
import { createPermDock } from "permdock/agent";

const agent = createPermDock(policy, {
  subject: (ctx: Context) => ctx.user,
  actor: (ctx) => ({ id: ctx.agentId, kind: "agent" }),
  delegation: (ctx) => ({ scopes: ctx.scopes }),
  operations,
  models: {
    "openai/gpt-5.2": permissions.model.frontier,
    "openai/gpt-5.2-mini": permissions.model.standard,
  },
  store, // ApprovalStore, for approval-required operations
});
```

| Member                                           | What it does                                                                                                                |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `decideOperation(name, input, ctx)`              | Loads the row through `data`, validates, decides and resumes an approval; never throws                                      |
| `allowedOperations(ctx)`                         | Names the subject could be granted for some row: a listing hint for the tool list, never a decision                         |
| `decideModel(id, ctx)`                           | The decision for one model; a model `models` does not name is denied                                                        |
| `permittedModels(ctx)`                           | Granted model ids in declaration order                                                                                      |
| `filterResults(name, rows, ctx)`                 | Keeps the rows the subject may see by the operation's `results`; rows unchanged without `results`; none for an unknown name |
| `gatewayOptions(ctx)`                            | `providerOptions.gateway` for the Vercel AI Gateway: principal id as `user`, `tenant:<id>` and `actor:<kind>` as `tags`     |
| `getPermDock(ctx)`, `tokenFor(name, input, ctx)` | The instance for a context, and the approval token a call would park under                                                  |

An operation `operations` does not name is denied unless `unmapped: 'allow'`. `gatewayOptions` carries identifiers only, never a decision. Use `filterResults` on search and list tools whose backend does not filter by subject.

Test an implementation with `testAgentRuntime({ name, mount, skip? })` from `permdock/testing`. `mount(domain)` returns `{ agent, close? }`, an `AgentPermDock` built from `domain.subject`, `domain.operations`, `domain.models` and `domain.store` ([agents](https://permdock.com/docs/concepts/agents), [testing](https://permdock.com/docs/adapters/testing)).

## Automations: `permdock/workflow`

A run acts as the automation's principal with live rights, narrowed to the automation's operations and to any policy delegation to `actor('automation')`. The trigger only needs the automation's `run` permission to start a run; it is recorded in `subject.context.trigger` and lends the run nothing.

### Publish

```ts
import { decideAutomation } from "permdock";
const decision = await decideAutomation(permdock, {
  id: "weekly-overdue",
  version: 1,
  operations: [operations.read_invoice, operations.send_invoice],
  run: permissions.report.run,
  name: "Overdue invoices",
});
if (decision.outcome === "granted") await automations.save(decision.automation);
```

`decideAutomation` checks that the publisher may use each operation's permission in the tenant, and returns an `Automation` record. A link, feed, contact, API key or run-ticket subject cannot publish.

| `mode`                | The run acts as                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| `publisher` (default) | The publisher, with their rights as of each run                                                      |
| `service`             | A `kind: 'service'` principal holding `roles` in `tenant`, capped at what the publisher could assign |

Bump `version` on every edit: a run ticket for another version is refused. `AutomationSource` is the live record store, read on every run; `memoryAutomationSource` is the in-process default.

### Run

```ts
import { createPermDock, pollingApprovalWaiter } from "permdock/workflow";

const workflow = createPermDock(policy, {
  signer, // TokenSigner for run tickets
  verifier, // TokenVerifier for run tickets
  principals, // PrincipalSource, read live on every step
  automations, // AutomationSource
  store: store,
  waiter: pollingApprovalWaiter({ store }),
  sink,
});

const started = await workflow.start("weekly-overdue", {
  caller: permdock,
  trigger: event,
});
// pass started.ticket as the job payload; in each step:
const run = await workflow.getPermDock(ticket);
run.can(permissions.invoice.send, invoice);
```

- `start(id, { caller, trigger })` reads the live automation, checks the caller's `run` permission and signs a run ticket (`vnd.permdock.run+jwt`, 24 hours by default). Without `caller`, only server code starts it.
- `getPermDock(ticket)` rebuilds the run on every step. A new version, a revoked automation or a publisher who is gone gives an instance that denies everything.
- `awaitApproval(ticket, permission, row)` decides, parks on the `waiter` while `approval-required`, then decides again with the token against the publisher's rights as of then.
- `openApproval(ticket, permission, row)` and `resumeApproval(ticket, permission, token, row)` are the two halves, for runners that wait outside the call. A request still pending denies with reason `approval`.
- `pollingApprovalWaiter({ store, interval })` polls every `interval` milliseconds (5,000 by default).

For Trigger.dev, Inngest, Temporal, Vercel Queues and pgmq: call `start` where the trigger arrives, pass the ticket as the payload, call `getPermDock(ticket)` at the top of each step, `openApproval` before the wait and `resumeApproval` after it. A wake-up carries no verdict ([automations](https://permdock.com/docs/concepts/automations)).

### Workflow SDK: `permdock/workflow-sdk`

```ts
import { createHook, sleep } from "workflow";
import { resumeHook, start } from "workflow/api";
import {
  authorizeHook,
  startAutomation,
  workflowSdkWaiter,
} from "permdock/workflow-sdk";

const waiter = workflowSdkWaiter({ createHook, resumeHook, sleep });

const started = await startAutomation(
  workflow,
  start,
  sendOverdue,
  "weekly-overdue",
  [invoiceId],
  { caller: permdock, trigger: event },
);
```

- `startAutomation(workflow, start, fn, id, args, options)` starts the Workflow SDK run with the ticket as the first argument only when `workflow.start` is granted.
- `waiter.wait(token)` parks inside the `"use workflow"` function; `openApproval` and `resumeApproval` run as `"use step"` functions around it. The approver handler calls `waiter.wake(token)` after `resolveApproval`.
- `authorizeHook(resumeHook, caller, permission, row, token, payload)` resumes any other hook only when `caller.decide(permission, row)` is granted. A hook token alone is not an identity ([Workflow SDK adapter](https://permdock.com/docs/adapters/workflow-sdk)).

## Chat: `permdock/chat`

A chat command runs an operation as the principal the verified chat author links to.

```ts
import { createPermDock } from "permdock/chat";

const chatPermDock = createPermDock(policy, {
  principals,
  memberships,
  store: store,
});

const pay = chatPermDock.protect(
  operations["invoice.pay"],
  async ({ input }) => {
    await invoices.pay(input.id);
    return `Paid ${input.id}.`;
  },
);

const result = await pay(author, { id: "inv_42" });
```

- A `ChatAuthor` is `{ provider, userId, workspace? }`, built only from an event whose platform signature the transport verified.
- `subjectFromChat(author, { principals })` resolves it through `principals.principalByIdentity({ kind: 'chat', provider, value: userId, workspace })`. A missing, malformed or unlinked author is anonymous, so every check denies with `anonymous`. It never throws.
- The identity link is app data, written when a signed-in user connects their chat account. `memoryPrincipalSource({ principals, identities })` holds links in process.
- `protect(operation, handler)` resolves `granted` with the handler's `value`, `denied` with the decision, or `approval-required` with an `ApprovalPrompt` (`null` without `approvals`). An approved request runs the handler once.
- `resolveAction(author, { approval, status, note? })` applies `approved` or `rejected` as the clicking author through `resolveApproval`. The button carries the request id, never the token. The requester never approves their own request ([chat](https://permdock.com/docs/concepts/chat)).

### Chat SDK: `permdock/chat-sdk`

`chat` here is the Chat SDK `Chat` instance.

```ts
import {
  approvalActions,
  approvalCard,
  chatSdkAuthor,
} from "permdock/chat-sdk";

chat.onNewMention(async (thread, message) => {
  const author = chatSdkAuthor(message.author, thread.adapter, {
    workspace: "T0ACME",
  });
  const result = await pay(author, { id: "inv_42" });
  await thread.post(
    result.outcome === "granted" ? result.value : "Not allowed.",
  );
});

const actions = approvalActions(chatPermDock, { workspace: "T0ACME" });
chat.onAction([...actions.actionIds], actions.onAction);
```

- `chatSdkAuthor(user, adapter, { workspace? })` reads only `userId`, never the email or display name, and returns `null` for a bot, the bot itself or the platform.
- `approvalCard(prompt, { approvalUrl, buttons? })` renders the prompt with a Review link and Approve and Reject buttons; `buttons: false` leaves only the link.
- `approvalActions(chatPermDock, { workspace?, onResult? })` routes the clicks to `resolveAction` ([Chat SDK adapter](https://permdock.com/docs/adapters/chat-sdk)).
