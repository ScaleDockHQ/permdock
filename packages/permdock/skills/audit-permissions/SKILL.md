---
name: audit-permissions
description: Review an existing PermDock setup. Use when auditing permissions, finding ungranted or unused leaves, missing human approvals on agent tools, closures that should be portable, validate never, or OWASP ASI02 / ASI03. Use whenever the user asks to audit, review, or harden PermDock.
---

# Audit PermDock

Read the app's `permissions.ts`, `policy.ts`, factory file, and every adapter guard. Prefer `permdock usage --json` and `permdock doctor --json` when `@permdock/cli` is installed; otherwise walk those files and the catalog by hand.

Write the report as a Markdown checklist the user can turn into pull requests. Every finding names the file and the permission or role.

## Inventory

List every leaf from `definePermissions`, every role from `defineRoles` / `role()`, every plan from `definePlans`, and every grant from `definePolicy` (`grants` and role bindings). Note which adapter entries import the policy (server/agent) versus the snapshot (client).

Done when every leaf, role, plan and grant is in the report, including leaves with zero grants.

## Ungranted and unused

- **Ungranted**: a leaf that no `allow` mentions. Dead API surface; grant it or delete the leaf.
- **Unused**: a leaf that is granted but never passed to `can` / `decide` / `assert` / `protect` / `tools` / `<Protected>`. Confirm with `usage --json` or a repo-wide search for the reference.

Done when every leaf is tagged granted+used, granted+unused, or ungranted.

## Agent surfaces

For every tool map (`tools` on `permdock/ai-sdk`, `permdock/claude-agent`, `permdock/eve`, `permdock/openai`, `permdock/mcp`):

- Instance actions load a row through `data`. A collection permission (`list`, `create`) on a handler that reads `args.id` is a miss.
- `delete`, `publish`, charge, and other destructive actions carry `approval: 'human'` when a model can invoke them.
- `subject` and `actor` come from the host session or `subjectFrom*`, never from tool arguments or a model-supplied id.

Done when every tool binding has the right arity and every destructive model-reachable action requires a human approval.

## Portability

Flag `where` closures (`portable: false` or a function body) that only compare fields the portable operators already cover (`eq`, `in`, `memberOf`, `sqlFunction`, …). Those should be JSON conditions so RLS and snapshots stay aligned. Flag `opaque` RLS grants that wrap a named helper (`job_permitted`, `authorize`) — rewrite as `sqlFunction` with a twin and map the name in `rls.functions`. Flag `where: { authorId: principal.id }` (or `subject.id`) when the resource already has a matching relation — prefer `to: relation(permissions.post, 'author')`.

Done when every closure is either marked portable-false with a reason or rewritten, and every owner-equals-principal condition that has a relation uses the relation.

## Quotas

A `limit: { count, per }` grant without `limits` on `createPermDock` always denies with `limit-unavailable`. `can` never consumes; a mutation that should spend a unit must call `decide` or `assert`.

Done when every quota grant has a `LimitStore` and no tool uses only `can` to enforce a rate.

## Validation and identity

- `validate: 'never'` on a policy that sees HTTP bodies, MCP args, or model output is a finding. Boundary data uses the resource schema; trusted server rows may skip it.
- Client entries (`permdock/react` and the client half of a framework adapter) import permissions and snapshots only.
- JWT verification, when present, uses `subjectFromJwt` with Discovery or an explicit `jwks` + `issuer`, and algorithms `Ed25519` / `ES256` / `PS256`.

Done when each of those three checks has a pass or a file-level finding.

## ASI02 and ASI03

Map the inventory onto [OWASP Agentic](https://permdock.dev/docs/security/owasp-agentic):

- **ASI02** (tool misuse): unmapped tools, collection permission on a row handler, missing `approval: 'human'`, capability lists that include denied tools.
- **ASI03** (identity and privilege abuse): model-supplied subject or actor, actor used as approver, resume token not rebound to permission + resource + subject + actor.

Done when each agent adapter in the app has an ASI02 line and an ASI03 line.

## Report

Lead with blockers (fail-open, trusted model subject, missing approval on a destructive tool). Then unused/ungranted. Then portable-vs-closure. End with suggested PRs, one finding per PR when the fixes are independent.
