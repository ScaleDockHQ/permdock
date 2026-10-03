---
name: permdock-agents
description: Guards AI agent tool calls with PermDock subjects, actors and delegation. Use when wiring tool maps in permdock/ai-sdk, permdock/claude-agent, permdock/openai, permdock/eve or permdock/mcp, separating the user (principal) from the agent (actor), declaring a delegation option or policy delegations, publishing an A2A Agent Card with permdock/a2a, registering WebMCP tools with permdock/webmcp, verifying Web Bot Auth signers as actors, or when agent calls are denied with no-delegation or not-delegated.
license: MIT
metadata:
  author: ScaleDockHQ
  homepage: https://permdock.dev/docs/security/delegation
  repository: https://github.com/ScaleDockHQ/permdock
---

# PermDock agents

An agent call has a principal (the user whose grants are evaluated), an actor (the agent making the call) and a delegation (what the user handed over). The decision is the principal's grants intersected with the delegation ([delegation](https://permdock.dev/docs/security/delegation)). Set up `permissions.ts`, `policy.ts` and the factory first with the `permdock-wire` skill (`npx skills add ScaleDockHQ/PermDock --skill permdock-wire`).

## Inputs (find out, or ask before starting)

- Runtimes in use: AI SDK, Claude Agent SDK, OpenAI Agents SDK, Eve, an MCP server, an A2A agent, WebMCP tools in a web page, signed bot traffic over HTTP.
- Where the principal comes from: the host session, a verified token, the runtime's session (Eve).
- Where the actor id comes from: runtime context, `authInfo.clientId`, an Agent Card, a request signature.
- What the user delegates, per call (scopes, `authorizationDetails`, GNAP `access`) or as standing policy ("members let the Eve agent read and update posts").
- Which tools are destructive or move money.

## Invariants

1. Subject and actor come from the host session or verified transport auth, never from tool arguments, a task body, a header the client sets, or model output.
2. An actor with no delegation is denied every check with `no-delegation`. Delegate explicit scopes, never the principal's whole role.
3. Delegation only narrows. A policy delegation is a ceiling, a token delegation on the same call must also cover the permission, and a `deny` or an `approval` still applies.
4. One permission per tool. An instance action loads its row through `data` from parsed arguments; a collection permission (`list`, `create`) on a handler that reads `args.id` is a bug.
5. Tool lists are hints. `capabilityMiddleware`, `guardTools`, MCP list filtering, the A2A extended card, `mayUse` and WebMCP registration hide tools; the server adapter still decides each call.
6. A failed Web Bot Auth signature throws `InvalidSignatureError`; it never becomes an anonymous actor.
7. Protocol rules come from the spec skills (`npx skills add ScaleDockHQ/scaledock-skills --skill <name>`): `mcp-authorization` for MCP auth, `a2a` for Agent Cards, `webmcp` for page tools, `web-bot-auth` for signatures, `owasp-agentic` for the threat checklist.

## Workflow

1. **Name the three parts per surface.** Write down the principal source, the actor source and the delegation source for each runtime from the Inputs. The adapter table on [delegation](https://permdock.dev/docs/security/delegation#how-adapters-fill-actor-and-delegation) shows what each adapter fills itself (MCP and A2A read token scopes; in-process runtimes take a `delegation` option).
   ✓ Every surface has all three, and none reads from model-controlled input.
2. **Map the tools.** Use the runtime's `createPermDock` with `subject`, `actor` and a `tools` map, and pass the returned hook to the runtime. -> [references/runtimes.md](references/runtimes.md)
   ✓ Every tool the agent can call has a `permission`, and every instance permission has a `data` loader that parses its arguments.
3. **Delegate.** Per call, return `{ scopes: [permissions.post.update.scope] }` (or `authorizationDetails`) from the `delegation` option. As standing policy, declare it once on the policy:

   ```ts
   definePolicy(permissions, {
     roles: [member],
     delegations: [
       {
         from: roles.member,
         to: actor('eve'),
         permissions: [permissions.post.read, permissions.post.update],
       },
     ],
     subject,
   });
   ```

   `from` takes a role, `authenticated()`, a plan or `assurance()`. `to` is an actor kind, or `{ kind, id }` for one agent. A permission outside the ceiling is denied with `not-delegated`.
   ✓ The agent is granted a delegated tool, and denied with `not-delegated` or `no-delegation` for anything else.

4. **Gate destructive tools.** Put `approval: { by }` on each destructive or money-moving grant and pass a `store` to the adapter. Follow the `permdock-approvals` skill (`npx skills add ScaleDockHQ/PermDock --skill permdock-approvals`).
   ✓ A destructive tool returns the runtime's approval outcome instead of running.
5. **Wire the agent-facing surfaces.** A2A: serve `agentCard()` publicly, `extendedAgentCard(auth)` behind auth, and `protectSkill` on the task endpoint. WebMCP: `registerTools` from a snapshot, with the server re-checking. Web Bot Auth: `webBotAuth: (request) => verifyWebBotAuth(request, { verify: true, keys })` on the HTTP adapter. -> [references/runtimes.md](references/runtimes.md)
   ✓ Each surface passes the Verify list of its spec skill.
6. **Test.** Add scenario tests with `permdock/testing` for one delegated grant, one `not-delegated` denial and one approval per destructive tool ([scenario testing](https://permdock.dev/docs/guides/scenario-testing)). Then review with the `permdock-audit` skill, which reports ASI02 and ASI03 per adapter.
   ✓ The tests pass and the audit has no blocker.

## Verify before done

- [ ] No `subject`, `actor`, tenant or approval token is read from tool arguments, a task body or model output.
- [ ] Every in-process agent adapter sets `delegation`, or a policy `delegations` entry covers its actor kind.
- [ ] Every instance tool has a `data` loader; no collection permission guards a handler that reads one row.
- [ ] MCP servers set `resource` to their own URL; Claude Agent `mcp__` tools come only from `mcpSources`.
- [ ] WebMCP and capability filtering are backed by a server-side check on the same permission.
- [ ] Every destructive tool returns `approval-required`, and the `permdock-approvals` Verify list passes.

## Reference index

- [references/runtimes.md](references/runtimes.md): factory shapes and outcome mapping for AI SDK, Claude Agent SDK, Eve, OpenAI Agents SDK, MCP, A2A, WebMCP, Web Bot Auth and `permdock/terminal`.
- Docs: [delegation](https://permdock.dev/docs/security/delegation), [subject](https://permdock.dev/docs/concepts/subject), [OWASP Agentic mapping](https://permdock.dev/docs/security/owasp-agentic), adapter pages under `https://permdock.dev/docs/adapters/<name>`.
