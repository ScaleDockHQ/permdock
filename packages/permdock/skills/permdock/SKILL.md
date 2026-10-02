---
name: permdock
description: Explains how PermDock decides and routes to the right PermDock skill. Use first for any work with permdock, typed permissions, roles or access control in a TypeScript app, when a check is denied and the reason is unclear, when reading a Decision, denial reason or doctor code, when looking up current PermDock identifiers through the docs MCP, or when choosing between the permdock-wire, permdock-audit, permdock-agents, permdock-approvals, permdock-tenancy, permdock-data and permdock-credentials skills.
license: MIT
metadata:
  author: ScaleDockHQ
  homepage: https://permdock.dev/docs/for-ai-agents
  repository: https://github.com/ScaleDockHQ/permdock
---

# PermDock

PermDock is typed permissions for TypeScript apps, APIs, databases and AI agents. Permissions are defined once, decided in process, compiled to queries and RLS, and serialised to client snapshots ([for AI agents](https://permdock.dev/docs/for-ai-agents)). This skill holds the model every other PermDock skill assumes, and says which one to load.

## Inputs (find out before starting)

- Whether the app already has `permissions.ts`, `policy.ts` and a `createPermDock` factory file. None means start with `permdock-wire`.
- The task: set up, review, or one area (agents, approvals, tenants, queries and RLS, tokens and keys).
- Whether the `permdock` binary runs in the repo (`pnpm exec permdock doctor`).

## Invariants

1. **Fail-closed.** Anything unknown, invalid or thrown denies. `can()` never throws. A `Decision` is only `granted`, `denied` or `approval-required`.
2. **Deny overrides allow.** Allows OR together; any matching `deny` wins.
3. **References, not strings.** Pass `permissions.post.update`; strings appear only as `.key` / `.scope` on the wire, in catalogs and in audit.
4. **Authentication is upstream.** Core never verifies a token. The subject comes from a `subjectFrom*` resolver or the server session, never from a request body, an unsigned header, a CLI flag or model output.
5. **Server and client stay apart.** `policy.ts` and `createPermDock` never reach a client entry (doctor PD001); clients read snapshots, and a client check is a hint the server repeats.
6. **Portable first.** Conditions that the in-memory evaluator, `where()` and RLS all understand beat closures.
7. **The Cloud is optional.** No decision waits on PermDock Cloud; every hosted feature is an interface with an in-process default.

## Workflow

1. **Pick the skill.** Install the one the task needs with `npx skills add ScaleDockHQ/PermDock --skill <name>` (or all of them with `npx skills add ScaleDockHQ/PermDock`, or `pnpm exec permdock skills install` to match the installed package version):

   | Task                                                    | Skill                  |
   | ------------------------------------------------------- | ---------------------- |
   | Add PermDock, first guard, limits, plans, CLI checks    | `permdock-wire`        |
   | Review an app or a pull request                         | `permdock-audit`       |
   | Agent tool calls, actors, delegation, A2A, WebMCP       | `permdock-agents`      |
   | Human approval, approvers, quorum, resume               | `permdock-approvals`   |
   | Named scopes, memberships, ownership, custom roles      | `permdock-tenancy`     |
   | ORM queries, generated RLS, relationship graphs, parity | `permdock-data`        |
   | Access tokens, API keys, service accounts, share links  | `permdock-credentials` |

   ✓ The skill for the task is loaded, and `permdock-wire` has run first if the app has no factory file.

2. **Look identifiers up, never guess them.** Read the owning page through the docs MCP (`https://permdock.dev/mcp`, tools `search_docs` and `get_page`), or append `.md` to any `https://permdock.dev/docs/...` URL. Every public name follows the [naming convention](https://permdock.dev/docs/getting-started/naming).
   ✓ Each identifier written into the app appears on a docs page or in `node_modules/permdock`.
3. **Read a decision.** `decide()` returns `{ outcome, denials: [{ reason, ... }], alternatives }`. `reason` is one of the closed list on [decisions](https://permdock.dev/docs/concepts/decisions); `alternatives` are permissions on the same resource the subject does hold. HTTP adapters answer RFC 9457 Problem Details ([errors](https://permdock.dev/docs/concepts/errors)); for the format, defer to the `problem-details` spec skill (`npx skills add ScaleDockHQ/scaledock-skills --skill problem-details`).
   ✓ Each denial the user asked about is named by its reason.
4. **Explain an unexpected denial.** Run `permdock.explain(permission, data)` in a test or a script. `trace.denies[0]` is the deny that won (give denies a `name` so it reads as a rule), `trace.allows` the allows it overrode, `trace.skipped` the grants passed over and why ([explain](https://permdock.dev/docs/concepts/decisions#explain)). The trace never reaches the decision log. To preview a plan before acting, `simulate([[permission, data], ...])` returns every decision.
   ✓ The cause is a named grant, condition or missing input, not a guess.
5. **Check the project.** Run `pnpm exec permdock doctor` (`--json` for machine output). Each finding has a stable `PD0xx` code and a one-line fix ([doctor](https://permdock.dev/docs/cli/doctor)); the topic skills name the codes for their area.
   ✓ `permdock doctor` reports no error.

## Verify before done

- [ ] No identifier was written from memory; each one is on a docs page or in the package.
- [ ] Nothing reads a subject, tenant, membership or approval token from model output, a request body or an unsigned header.
- [ ] `policy.ts` is imported only from server code.
- [ ] The topic skill used for the task has its Verify list passing.

## Reference index

- Skills: `permdock-wire`, `permdock-audit`, `permdock-agents`, `permdock-approvals`, `permdock-tenancy`, `permdock-data`, `permdock-credentials`, all from `npx skills add ScaleDockHQ/PermDock --skill <name>`.
- Docs: [for AI agents](https://permdock.dev/docs/for-ai-agents), [naming](https://permdock.dev/docs/getting-started/naming), [policies](https://permdock.dev/docs/concepts/policies), [decisions](https://permdock.dev/docs/concepts/decisions), [threat model](https://permdock.dev/docs/security/threat-model), [doctor](https://permdock.dev/docs/cli/doctor), `https://permdock.dev/llms.txt`.
