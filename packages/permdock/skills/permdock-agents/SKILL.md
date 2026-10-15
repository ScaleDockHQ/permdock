---
name: permdock-agents
description: Guards AI agent tool calls, automations and chat commands with PermDock operations, subjects, actors and delegation. Use when declaring defineOperations, wiring operations in permdock/agent, permdock/ai-sdk, permdock/claude-agent, permdock/openai, permdock/eve or permdock/mcp, gating models or filtering tool results, running published automations with permdock/workflow or permdock/workflow-sdk, protecting chat commands and approval buttons with permdock/chat or permdock/chat-sdk, separating the user (principal) from the agent (actor), declaring a delegation option or policy delegations, publishing an A2A Agent Card with permdock/a2a, registering WebMCP tools with permdock/webmcp, verifying Web Bot Auth signers as actors, or when agent calls are denied with no-delegation or not-delegated.
license: MIT
metadata:
  author: ScaleDockHQ
  homepage: https://permdock.com/docs/security/delegation
  repository: https://github.com/ScaleDockHQ/permdock
---

# PermDock agents

An agent call has a principal (the user whose grants are evaluated), an actor (the agent making the call) and a delegation (what the user handed over). The decision is the principal's grants intersected with the delegation ([delegation](https://permdock.com/docs/security/delegation)). Agent tools, automations and chat commands read one table from `defineOperations` ([operations](https://permdock.com/docs/concepts/operations)). Set up `permissions.ts`, `policy.ts` and the factory first with the `permdock-wire` skill (`npx skills add ScaleDockHQ/PermDock --skill permdock-wire`).

## Inputs (find out, or ask before starting)

- Runtimes in use: AI SDK, Claude Agent SDK, OpenAI Agents SDK, Eve, another agent runtime, an MCP server, an A2A agent, WebMCP tools in a web page, signed bot traffic over HTTP.
- Automations: who publishes them, whether they run as the publisher or a service principal, and the runner (Workflow SDK, Trigger.dev, Inngest, Temporal, Vercel Queues, pgmq).
- Chat bots: the platform, the workspace id, and where the app stores the link from a chat user id to a principal.
- Where the principal comes from: the host session, a verified token, the runtime's session (Eve), a run ticket, a linked chat author.
- Where the actor id comes from: runtime context, `authInfo.clientId`, an Agent Card, a request signature.
- What the user delegates, per call (scopes, `authorizationDetails`, GNAP `access`) or as standing policy ("members let the Eve agent read and update posts").
- Which operations are destructive or move money, and which models each plan may use.

## Invariants

1. Subject and actor come from the host session or verified transport auth, never from tool arguments, a task body, a header the client sets, or model output.
2. An actor with no delegation is denied every check with `no-delegation`. Delegate explicit scopes, never the principal's whole role.
3. Delegation only narrows. A policy delegation is a ceiling, a token delegation on the same call must also cover the permission, and a `deny` or an `approval` still applies.
4. One permission per operation. An instance action loads its row through `data` from parsed input; a collection permission (`list`, `create`) on a handler that reads `args.id` is a bug. `meta` labels an operation and never decides.
5. Tool lists are hints. `allowedOperations`, `capabilityMiddleware`, `guardTools`, MCP list filtering, the A2A extended card, `mayUse` and WebMCP registration hide tools; the server still decides each call.
6. A trigger never grants. A run reads its principal's rights live on every step through `getPermDock(ticket)`; only the run ticket (`vnd.permdock.run+jwt`) travels between steps.
7. An unlinked chat author is anonymous. A `ChatAuthor` comes only from a verified platform event and its user id, never an email or display name; an approval button carries the request id, never the token.
8. A failed Web Bot Auth signature throws `InvalidSignatureError`; it never becomes an anonymous actor.
9. Protocol rules come from the spec skills (`npx skills add ScaleDockHQ/scaledock-skills --skill <name>`): `mcp-authorization` for MCP auth, `a2a` for Agent Cards, `webmcp` for page tools, `web-bot-auth` for signatures, `owasp-agentic` for the threat checklist.

## Workflow

1. **Name the three parts per surface.** Write down the principal source, the actor source and the delegation source for each surface from the Inputs. The adapter table on [delegation](https://permdock.com/docs/security/delegation#how-adapters-fill-actor-and-delegation) shows what each adapter fills itself (MCP and A2A read token scopes; in-process runtimes take a `delegation` option). An automation run's actor is `automation` and its delegation is its operations' permissions; a chat command's principal is the linked author.
   ✓ Every surface has all three, and none reads from model-controlled input or a trigger payload.
2. **Define the operations.** One `defineOperations(permissions, { name: { permission, data?, results?, meta? } })` module for the app, with names in MCP tool-name characters and `meta: { risk, effects, title }` on destructive operations. -> [references/operations-automations-chat.md](references/operations-automations-chat.md#operations-defineoperations-from-permdock)
   ✓ Every operation names a leaf of the tree, and every instance permission has a `data` loader that parses its input.
3. **Map the agent tools.** Use the runtime's `createPermDock` with `subject`, `actor`, `delegation` and `operations`, and pass the returned hook to the runtime. For a runtime with no adapter, use `createPermDock` from `permdock/agent` and call `decideOperation(name, input, ctx)` per call. Add `models` for a model gate and `filterResults` on list tools. -> [references/runtimes.md](references/runtimes.md), [agent contract](references/operations-automations-chat.md#agent-contract-permdockagent)
   ✓ Every tool the agent can call is an operation, and an unnamed tool is denied unless `unmapped: 'allow'` is deliberate.
4. **Delegate.** Per call, return `{ scopes: [permissions.post.update.scope] }` (or `authorizationDetails`) from the `delegation` option. As standing policy, declare it once on the policy:

   ```ts
   definePolicy(permissions, {
     roles: [member],
     delegations: [
       {
         from: roles.member,
         to: actor("eve"),
         permissions: [permissions.post.read, permissions.post.update],
       },
     ],
     subject,
   });
   ```

   `from` takes a role, `authenticated()`, a plan or `assurance()`. `to` is an actor kind, or `{ kind, id }` for one agent. A permission outside the ceiling is denied with `not-delegated`.
   ✓ The agent is granted a delegated tool, and denied with `not-delegated` or `no-delegation` for anything else.

5. **Gate destructive operations.** Put `approval: { by }` on each destructive or money-moving grant and pass a `store` to the adapter. Follow the `permdock-approvals` skill (`npx skills add ScaleDockHQ/PermDock --skill permdock-approvals`).
   ✓ A destructive operation returns the runtime's approval outcome instead of running.
6. **Run automations.** Publish with `decideAutomation(permdock, request)` and store the `Automation` record. Start runs with `start(id, { caller, trigger })` from the `permdock/workflow` factory, call `getPermDock(ticket)` at the top of every step, and wait with `awaitApproval` or `openApproval` plus `resumeApproval`. On the Workflow SDK use `startAutomation`, `workflowSdkWaiter` and `authorizeHook` from `permdock/workflow-sdk`. -> [references/operations-automations-chat.md](references/operations-automations-chat.md#automations-permdockworkflow)
   ✓ A demoted publisher's next step denies, and a caller without the automation's `run` permission starts nothing.
7. **Protect chat commands.** Use `createPermDock` from `permdock/chat` with `principals` and `approvals`, wrap each command with `protect(operation, handler)`, and apply buttons with `resolveAction`. On the Chat SDK, build authors with `chatSdkAuthor` and render `approvalCard` with `approvalActions`. -> [references/operations-automations-chat.md](references/operations-automations-chat.md#chat-permdockchat)
   ✓ An unlinked author is denied with `anonymous`, and the requester's own click on an approval card is refused.
8. **Wire the agent-facing surfaces.** A2A: serve `agentCard()` publicly, `extendedAgentCard(auth)` behind auth, and `protectSkill` on the task endpoint. WebMCP: `registerTools` from a snapshot, with the server re-checking. Web Bot Auth: `webBotAuth: webBotAuthVerifier({ verify: true, keys })` on the HTTP adapter. -> [references/runtimes.md](references/runtimes.md)
   ✓ Each surface passes the Verify list of its spec skill.
9. **Test.** Add scenario tests with `permdock/testing` for one delegated grant, one `not-delegated` denial and one approval per destructive operation ([scenario testing](https://permdock.com/docs/guides/scenario-testing)). Run `testAgentRuntime` against a `permdock/agent` integration. Then review with the `permdock-audit` skill, which reports ASI02 and ASI03 per adapter.
   ✓ The tests pass and the audit has no blocker.

## Verify before done

- [ ] No `subject`, `actor`, tenant or approval token is read from tool arguments, a task body, a trigger payload or model output.
- [ ] Every in-process agent adapter sets `delegation`, or a policy `delegations` entry covers its actor kind.
- [ ] Agent adapters, automations and chat commands read one `defineOperations` map; no adapter keeps its own tool-to-permission table.
- [ ] Every instance operation has a `data` loader; no collection permission guards a handler that reads one row.
- [ ] List and search operations whose backend does not filter by subject declare `results` and go through `filterResults`.
- [ ] A `models` map gates every model the agent may call, when plans or roles price models.
- [ ] MCP servers set `resource` to their own URL; Claude Agent `mcp__` tools come only from `mcpSources`.
- [ ] WebMCP, capability filtering and `allowedOperations` are backed by a server-side check on the same permission.
- [ ] Every automation step calls `getPermDock(ticket)` itself, `version` changes on every edit, and an approval wait resumes through `resumeApproval` or `awaitApproval`, never from the wake-up payload.
- [ ] Chat authors come from verified platform events through `subjectFromChat` or `chatSdkAuthor`, and approval buttons carry the request id.
- [ ] Every destructive operation returns `approval-required`, and the `permdock-approvals` Verify list passes.

## Reference index

- [references/runtimes.md](references/runtimes.md): factory shapes and outcome mapping for AI SDK, Claude Agent SDK, Eve, OpenAI Agents SDK, MCP, A2A, WebMCP, Web Bot Auth and `permdock/terminal`.
- [references/operations-automations-chat.md](references/operations-automations-chat.md): `defineOperations`, the `permdock/agent` contract, `permdock/workflow` and `permdock/workflow-sdk`, `permdock/chat` and `permdock/chat-sdk`.
- Docs: [delegation](https://permdock.com/docs/security/delegation), [subject](https://permdock.com/docs/concepts/subject), [operations](https://permdock.com/docs/concepts/operations), [agents](https://permdock.com/docs/concepts/agents), [automations](https://permdock.com/docs/concepts/automations), [chat](https://permdock.com/docs/concepts/chat), [OWASP Agentic mapping](https://permdock.com/docs/security/owasp-agentic), adapter pages under `https://permdock.com/docs/adapters/<name>`.
