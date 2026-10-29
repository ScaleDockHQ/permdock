# Approval stores and the resume flow

The API and the store contract are on the [approvals adapter](https://permdock.com/docs/adapters/approvals); the token and the runtime table are on [approval security](https://permdock.com/docs/security/approvals).

## Store and handler

```ts
import { approvalsHandler, memoryApprovalStore } from "permdock/approvals";

export const store = memoryApprovalStore({ ttl: 60 * 60 }); // seconds; default one hour

// Every agent and HTTP adapter takes the same option
export const { protect } = createPermDock(policy, { subject, store });

// Routes for approvers: GET /pending, GET /mine, GET /:id, GET /:id/signature, POST /:id/approve, POST /:id/reject
const handler = approvalsHandler(store, {
  subject: (request) => approverFromSession(request), // the approver, from real authentication
  requireDistinctApprover: false, // true refuses the principal even where a grant sets mode: "confirm"
  relations, // RelationSource: needed when a grant uses relation() approvers
  permissions, // the permission tree, for relation approvers reached through links
});
app.all("/permdock/approvals/*", (c) => handler(c.req.raw));
```

- `GET /:id` returns one request without its token, with a strong `ETag`; `If-None-Match` answers `304`. Unknown and foreign ids are `404`.
- `POST /:id/approve` and `POST /:id/reject` honour `If-Match` with that `ETag`. A stale tag is `412`, so two approvers on one screen cannot overwrite each other. Send `If-Match` from the confirmation screen.
- `GET /:id/signature` serves the signed approval (`vnd.permdock.approval+jwt`) when the handler has a `signer` and the request is approved, to the requester and the approvers only.

The store's `ttl` is the window a request stays open when the call sets none; `resumeDecision({ ..., ttl })` sets it per call (milliseconds). A grant's `approval.ttl` only shortens either.

- `memoryApprovalStore` is per process. On serverless or with several replicas, implement `ApprovalStore` over the app's database; the Drizzle recipe on the adapter page is the template, and `cloud().approvals` from `permdock/cloud` is the hosted implementation of the same interface. On Postgres or Supabase, set `rls.approvals: true` and use `supabaseApprovalStore(admin, { onOpen })` from `permdock/supabase` over the generated table and functions; grant the functions to the server's role, and put notifications and superseding older requests in `onOpen`. Over an adopted table with `open: 'attach'`, insert the app's own row holding `request.token` in `beforeOpen`, which runs before every open and must ignore a conflict on the token.
- A custom store calls `assertApprover(request, by, requireDistinct, now, verdict.relations)` in `resolve` and computes the next record with `applyApprovalVerdict`, which records each signature's `stage`. `verdict.relations` holds `approverRelationKey` values that the handler, or `resolveApproval(store, token, verdict, { relations, permissions })`, computed with `approverRelations`; a store never derives them. `consume` must be atomic: two concurrent calls never both succeed.
- When the app's own rules decide who approves (a manager chain, delegates, a quorum it counts), record their verdict with `vouchApproval(store, token, { status, by, rule })` from `permdock/approvals` instead of mirroring those rules in `approvers` or copying the verdict into the request by hand. It resolves the request at once and records `vouched: rule`; the actor, requester and repeat checks still apply. Never take `vouched` from a request body.
- Run `testApprovalStore(store, { reopen, capabilities: { expire } })` from `permdock/testing` on every custom store. `reopen` opens a second client over the same backend; `expire(token)` ages one record so the suite checks that a new ask replaces it.
- `create` replaces a record only when its `status` is `expired` or its `expiresAt` has passed. A pending or resolved record stays, and nothing returns to `pending`.
- `cancelApprovals` rejects matching pending requests (for example when a session ends).

## Approval policies as data

```ts
import { getPermDock, memoryApprovalPolicySource } from "permdock";

const permdock = await getPermDock(policy, user, {
  approvalPolicies: memoryApprovalPolicySource([
    {
      permission: "expense.pay",
      tenant: "o_acme", // absent: every tenant
      actors: ["agent"], // absent: every call
      where: { op: "gt", field: "amount", value: 1000 },
      approval: { by: "finance" }, // an escalation here widens only this entry's stages
    },
  ]),
});
```

- Every adapter's `createPermDock` takes `approvalPolicies` (HTTP, MCP, A2A, AuthZEN, terminal and the agent adapters), so an entry also turns an agent call into `user-approval` or an MCP call into `approval-required`.
- Entries are read once per instance and combine with the grant's own approval as stages (`sequential` if any part is, else `all`); the shortest `ttl` wins.
- A throw or an invalid entry denies with detail `approval-policy-unavailable`. An unknown permission applies to nothing.
- `where` reads the row, so it works only on instance permissions; on a collection permission the entry does not load. Use `check` (the proposed row) there. Validate entries where they are saved with `validateApprovalPolicy(policy, entry)` (`{ ok: false, problem }` names `unknown-permission`, `invalid`, `where-on-collection` or `stale-on-without-version`).
- Client snapshots do not see the entries; the server's `decide` adds the approval.

## Resume

1. `decide` returns `approval-required` with a deterministic `token`. The adapter calls `store.create`; `create` is idempotent per token.
2. The runtime surfaces the ask (table below). A person answers through `approvalsHandler`, the runtime's own UI or the Cloud inbox.
3. The original call is retried with the token. The adapter re-runs `decide`, recomputes the token, compares it, and calls `store.consume`. Only then does the tool or route run.

The token is `sha-256:<base64url>`, a digest of the RFC 8785 JSON of the permission key, the resource id (or a digest of the data when there is no id), the principal, the tenant, the actor and the matched grant's conditions. Under `staleOn: 'resource-change'` it also binds the row's `version`. Treat it as opaque: compare it, never parse it.

A `DecisionSink` receives the request's lifecycle as CloudEvents `com.permdock.approval.requested`, `com.permdock.approval.resolved`, `com.permdock.approval.expired` and `com.permdock.approval.cancelled` ([wire formats](https://permdock.com/docs/concepts/wire-formats)). An event never approves; a consumer that acts on `resolved` still resumes through the store.

A gate in your own code resumes the same way with `resumeDecision` from `permdock/approvals`, passing `token: carried ?? (await storedApprovalToken(store, decision))`: `storedApprovalToken` finds an approved or rejected request for the recomputed token, so the caller need not carry it. Do not reimplement it.

Over HTTP, the client retries the same request with the `PermDock-Approval: <token>` header. In React, `approvalHeaders(token)` builds that header and `useApproval(decision)` requests and polls an approval from the UI.

A bad resume is denied with detail `approval-not-found`, `approval-pending`, `approval-rejected`, `approval-expired`, `approval-consumed` or `approval-mismatch`; a changed row is `stale-approval`. `approvalsHandler` answers `403` for an ineligible approver (`approver-not-eligible`, the actor, or the principal without `mode: "confirm"`) and `409` for a repeated one (`approver-repeated`).

## Delegation

Pass `approvalDelegations` (`memoryApprovalDelegationSource` or your table) and `subjectFor` to `approvalsHandler`. A delegate may approve what the delegator could, inside `from` (inclusive) and `until` (exclusive). The signature records `by` as the delegate and `onBehalfOf` plus `delegation` for the person covered. The store checks the delegator again. A link or a feed cannot approve. See [delegation](https://permdock.com/docs/adapters/approvals#delegation).

## Access reviews

`startAccessReview` lists holders of a set of permissions. `decideAccessReviewItem` records keep or revoke. The application changes the role or membership, then marks the item applied. `accessReviewsHandler` serves the routes. See [access reviews](https://permdock.com/docs/concepts/access-reviews).

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

Send the prompt with `approvalPrompt` and `permdock/delivery`: `approvalEmail` from `permdock/resend`, `approvalCard` and `approvalActions` from `permdock/chat-sdk`. A prompt carries the request id, never the token, and links to the app's approval page, where the approver signs in; the verdict goes through `approvalsHandler` with that session's subject. A link never approves. Details in [delivery-and-waiters.md](delivery-and-waiters.md#approval-prompts).

## Approvers

`by` takes roles, `user(id)`, `relation()`, `manager({ levels? })` (whoever holds `manager` on the requester's `user` record, up to `levels` steps), `holder(permission)` and `anyOf(...)`. A list is all-of; use `anyOf(user(id), holder(permissions.x.approve))` for "this person or anyone who holds the permission". `holder()` needs `approvalsHandler(store, { permdockFor: (approver, request) => createPermDock(policy, approver, { customRoles }) })`, so custom roles count. Stages may carry their own `escalation`.

## Operation fingerprints

Bind an approval to the exact operation with `fingerprint`: `permdock.decide(permission, row, { fingerprint: approvalFingerprint({ id, amount, to }) })`. The token and the stored request carry it, and a resume or `consumeApproval(store, token, at, { fingerprint })` under another one fails with `approval-fingerprint-mismatch`. `approvalFingerprint` returns the same hex string as better-supabase's, synchronously.
