# `@permdock/example-workflow-sdk`

A PermDock automation running on the [Workflow SDK](https://useworkflow.dev) in Next.js. `send-overdue` is published by `u_billing`, whose `billing` role holds `invoice.send` only with an approval. The run opens the approval request in one step, parks on its hook, and sends in the next step once `u_finance` approves.

```ts
import { createPermDock } from "permdock/workflow";
import { startAutomation, workflowSdkWaiter } from "permdock/workflow-sdk";
```

```bash
pnpm build && pnpm start
curl -X POST localhost:3490/api/runs -H 'content-type: application/json' -d '{"invoiceId":"inv_42"}'
curl localhost:3490/api/approvals
curl -X POST localhost:3490/api/approvals/<token>
```

| File                                     | Role                                                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `src/runs.ts`                            | `createPermDock` from `permdock/workflow` with a per-process Ed25519 key and a memory approval store |
| `src/workflows/send-overdue.ts`          | The `"use workflow"` function; waits on `workflowSdkWaiter` between the steps                        |
| `src/workflows/steps.ts`                 | `openApproval` and `resumeApproval` as `"use step"` functions                                        |
| `src/app/api/runs/route.ts`              | `startAutomation` from server code; a denied start creates no Workflow SDK run                       |
| `src/app/api/approvals/[token]/route.ts` | `resolveApproval` as `u_finance`, then `waiter.wake(token)`                                          |

The run ticket key and the stores live in memory, so a restart ends every pending run. The approver is fixed in code; a real app takes it from its verified session.
