---
name: audit-permissions
description: Review an existing PermDock setup or a pull request that changes it. Use when auditing permissions, reviewing a PR that touches permissions.ts or policy.ts, finding ungranted or unused leaves, missing human approvals on agent tools, closures that should be portable, validate never, or OWASP ASI02 / ASI03. Use whenever the user asks to audit, review, or harden PermDock.
---

# Audit PermDock

Read the app's `permissions.ts`, `policy.ts`, factory file, and every adapter guard. Prefer `permdock usage --json` and `permdock doctor --json` (the `permdock` binary ships in the `permdock` package); otherwise walk those files and the catalog by hand.

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
- `delete`, `publish`, charge, and other destructive actions carry `approval: { by }` (or `'human'`) when a model can invoke them. `by` names eligible approvers; adapter `approvers` is an extra restriction. `permdock doctor` PD017 warns on sensitive verbs (`pay`, `approve`, `settle`, `submit`, `transfer`, `refund`, `disburse`) without approval.
- Every approval refuses the requester by default. Each `approval: { distinct: false }` (PD024) lets a user approve their own request; it is a finding unless the grant is a deliberate "confirm your own agent's call" and no money, deletion or access change sits behind it.
- Roles that must not be held together use `exclusiveWith`; PD018 and `separationConflicts` report fixture and custom-role collisions.
- Role changes: a server action that writes a membership role without `decideRoleChange` (or that passes an actor or a guessed `holders` count) is a finding. The managing role of each scope sets `min: 1` (PD026); admin-like roles set `for` so guest, contact or partner memberships cannot hold them; `assigns` lists never let a role appoint one ranked above it.
- Custom roles: a save action that writes a `CustomRole` without `validateCustomRole` and an `assignablePermissions()` check is a finding. A monolithic assignable `admin` makes the ceiling too wide; split it into small assignable roles. PD023 reports fixture custom roles whose keys the ceiling drops.
- `subject` and `actor` come from the host session or `subjectFrom*`, never from tool arguments or a model-supplied id.

Done when every tool binding has the right arity and every destructive model-reachable action requires a human approval.

## Portability

Flag `where` closures (`portable: false` or a function body) that only compare fields the portable operators already cover (`eq`, `in`, `memberOf`, `sqlFunction`, …). Those should be JSON conditions so RLS and snapshots stay aligned. Flag `opaque` RLS grants that wrap a named helper (`job_permitted`, `authorize`) — rewrite as `sqlFunction` with a twin and map the name in `rls.functions`. Flag `where: { authorId: principal.id }` when the resource already has a matching relation — prefer `to: relation(permissions.post, 'author')`. Flag attribute conditions on `context.*` in a project with an `rls` config (doctor PD027): the database cannot enforce them; compare with a server-set `principal.claims.*` claim instead, never one from `user_metadata`. On Supabase, check that `supabase.hook.attrs` lists only server-owned columns or `app_metadata.<key>` entries clients cannot update (doctor PD028).

Done when every closure is either marked portable-false with a reason or rewritten, and every owner-equals-principal condition that has a relation uses the relation.

## Quotas

A `limit: { count, per }` grant without `limits` on `createPermDock` always denies with `limit-unavailable`. `can` never consumes; a mutation that should spend a unit must call `decide` or `assert`.

Done when every quota grant has a `LimitStore` and no tool uses only `can` to enforce a rate.

## Validation and identity

- `validate: 'never'` on a policy that sees HTTP bodies, MCP args, or model output is a finding. Boundary data uses the resource schema; trusted server rows may skip it.
- Client entries (`permdock/react` and the client half of a framework adapter) import permissions and snapshots only.
- JWT verification, when present, uses `subjectFromJwt` with Discovery or an explicit `jwks` + `issuer`, and algorithms `Ed25519` / `ES256` / `PS256`.
- Supabase: every `ctx.supabaseAdmin`, `withPostgresAdminClient` or `service_role` client use sits in a handler that called `permdock.assert(...)` (or ran behind `withPermDock({ protect })`) first; those clients bypass RLS. `subjectFromSupabase` receives `getClaims()` output or `ctx.jwtClaims`, never `getSession().access_token` or `user_metadata`.

Done when each of those four checks has a pass or a file-level finding.

## Tests

- No `describePolicy` suite, or one with `exhaustive: false`, is a finding: a new permission can ship untested.
- A list endpoint that uses `where()` / `toWhere` or generated RLS without an `ormParity` or `rlsParity` run is a finding.
- A custom `ApprovalStore`, `DecisionSink`, `MembershipSource`, `RoleSource`, `SnapshotSource`, `LimitStore` or `DirectoryStore` without its `test<Interface>` runner from `permdock/testing` is a finding.
- Expectations computed by calling `decide` or `can` in the test are a finding; write the expected outcome by hand.

Done when every policy, list query and custom store has its runner, or a finding.

## ASI02 and ASI03

Map the inventory onto [OWASP Agentic](https://permdock.dev/docs/security/owasp-agentic):

- **ASI02** (tool misuse): unmapped tools, collection permission on a row handler, missing `approval: 'human'`, capability lists that include denied tools.
- **ASI03** (identity and privilege abuse): model-supplied subject or actor, actor used as approver, principal allowed to approve (`distinct: false`) on a sensitive action, resume token not rebound to permission + resource + subject + actor, API keys stored in plain text or created outside `decideCredential`, keys without expiry (doctor PD029), and a `memberships` source applied to service-key subjects.

Done when each agent adapter in the app has an ASI02 line and an ASI03 line.

## Pull request review

When the task is one pull request rather than the whole app, review only what the diff changes, against the base branch:

- Run `permdock collect --check` and `permdock usage --json` on both sides and compare. New leaves with no grant, grants for leaves nobody checks, and new `undeclared` or `outsideInclude` findings are review comments.
- A new or widened `allow` (a role gains a leaf, a `where` is dropped or loosened, a `to` becomes `anyone` or `authenticated`) needs a matching `describePolicy` matrix row in the same PR. A deny that is removed needs one too.
- A new model-reachable tool, or a new destructive action on an existing one, follows the Agent surfaces checks above.
- A change to `rls` config or generated RLS comes with `permdock rls generate --check` passing and an `rlsParity` or `rls verify` run.
- `permdock doctor --json` on the head branch reports no new error.

Post one comment per finding on the changed line, and lead the summary with anything that widens access.

Done when every changed grant, leaf and tool has a comment or an explicit pass.

## Report

Lead with blockers (fail-open, trusted model subject, missing approval on a destructive tool). Then unused/ungranted. Then portable-vs-closure. End with suggested PRs, one finding per PR when the fixes are independent.
