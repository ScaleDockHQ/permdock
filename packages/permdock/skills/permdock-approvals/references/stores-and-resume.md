# Approval stores and the resume flow

The API and the store contract are on the [approvals adapter](https://permdock.dev/docs/adapters/approvals); the token and the runtime table are on [approval security](https://permdock.dev/docs/security/approvals).

## Store and handler

```ts
import { approvalsHandler, memoryApprovalStore } from 'permdock/approvals';

export const store = memoryApprovalStore({ ttl: 60 * 60 * 1000 }); // default: one hour

// Every agent and HTTP adapter takes the same option
export const { protect } = createPermDock(policy, { subject, store });

// Routes for approvers: GET /pending, GET /mine, GET /:token, POST /:token/approve, POST /:token/reject
const handler = approvalsHandler(store, {
  subject: (request) => approverFromSession(request), // the approver, from real authentication
  requireDistinctApprover: false, // true refuses the principal even where a grant sets distinct: false
});
app.all('/permdock/approvals/*', (c) => handler(c.req.raw));
```

- `memoryApprovalStore` is per process. On serverless or with several replicas, implement `ApprovalStore` over the app's database; the Drizzle recipe on the adapter page is the template, and `cloud().approvals` from `permdock/cloud` is the hosted implementation of the same interface.
- A custom store calls `assertApprover(request, by, requireDistinct)` in `resolve` and computes the next record with `applyApprovalVerdict`. `consume` must be atomic: two concurrent calls never both succeed.
- Run `testApprovalStore(store, { reopen })` from `permdock/testing` on every custom store.
- `cancelApprovals` rejects matching pending requests (for example when a session ends).

## Resume

1. `decide` returns `approval-required` with a deterministic `token`. The adapter calls `store.create`; `create` is idempotent per token.
2. The runtime surfaces the ask (table below). A person answers through `approvalsHandler`, the runtime's own UI or the Cloud inbox.
3. The original call is retried with the token. The adapter re-runs `decide`, recomputes the token, compares it, and calls `store.consume`. Only then does the tool or route run.

The token binds the permission key, the resource id (or a digest of the data when there is no id), the principal, the tenant, the actor and the matched grant's conditions. Under `staleOn: 'resource-change'` it also binds the row's `version`.

Over HTTP, the client retries the same request with the `PermDock-Approval: <token>` header. In React, `approvalHeaders(token)` builds that header and `useApproval(decision)` requests and polls an approval from the UI.

A bad resume is denied with detail `approval-not-found`, `approval-pending`, `approval-rejected`, `approval-expired`, `approval-consumed` or `approval-mismatch`; a changed row is `stale-approval`. `approvalsHandler` answers `403` for an ineligible approver (`approver-not-eligible`, the actor, or the principal without `distinct: false`) and `409` for a repeated one (`approver-repeated`).

## Surfaces

| Runtime                                 | Ask                                                                                             | Resume                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| AI SDK `generateText` / `ToolLoopAgent` | `toolApproval` returns `'user-approval'`                                                        | The SDK's re-check of the same call is denied unless the store holds an approved record |
| AI SDK `WorkflowAgent`                  | `needsApproval(permission)` suspends the workflow                                               | The workflow resumes; the token is recomputed                                           |
| Claude Agent SDK                        | `canUseTool` denies with the token and records the request                                      | The retry consumes the approved record once                                             |
| Eve                                     | `approval.request` returns `user-approval`                                                      | `approval.response` checks the responder                                                |
| OpenAI Agents SDK                       | `needsApproval` pauses the run with `interruptions`                                             | `resolveInterruptions` applies the store's verdict                                      |
| MCP                                     | `input_required` URL elicitation to `approval.at`, otherwise an `isError` result with the token | The retried call re-runs `decide` and consumes                                          |
| HTTP adapters                           | `403` Problem Details, type `.../approval-required`, with `token`                               | Retry with `PermDock-Approval`                                                          |
| A2A                                     | The task enters input-required with the token                                                   | The caller continues the task                                                           |
| WebMCP                                  | The handler is not run; `onApprovalRequired` opens the page's dialog                            | The page calls the guarded route with the token                                         |
| Chat UI over AG-UI                      | The backend emits the request as an AG-UI human-in-the-loop or custom event                     | The answer returns on the stream; the backend recomputes the token                      |

For AG-UI event shapes, defer to the `ag-ui` spec skill (`npx skills add ScaleDockHQ/scaledock-skills --skill ag-ui`).

## Delivery

Notifying an approver is a listener on the `approval` event (`permdock.on('approval', …)`), never a package. A message or email carries only the token and links to a page where the approver signs in; the verdict goes through `approvalsHandler` with that session's subject. A link never approves on its own ([approvals adapter, Delivery](https://permdock.dev/docs/adapters/approvals#delivery)).
