# permdock

## 0.2.0

### Minor Changes

- 71bdf71: Open the 0.2 cycle after the 0.1.0 release.
- 45fb5d2: Add `sqlFunction` conditions with an in-memory twin so SQL-authority RLS helpers stay portable. `permdock rls` generates the call, imports mapped functions via `pgsql-parser`, and `verify --db` proves the twin. PermDock Cloud must accept the new node in snapshots and decision events.
- f9e31e1: Typed vocabulary (`defineRoles`, `definePlans`), `to:` grantee selectors, `principal` refs, `actions()`, and snapshot v3.

  Breaking before 1.0: `Role` is now the vocabulary leaf (`RoleBinding` is the grant list); `roles()` / `assignable()` rename to `heldRoles()` / `assignableRoles()` and return `Role[]`; `Grant.role` becomes `Grant.to`; snapshots emit `v: 3`.

### Patch Changes

- ed04e0a: Document PermDock Cloud production hosts: dashboard `https://app.permdock.com`, API `https://api.permdock.com`, read-only MCP `https://mcp.permdock.com`.
- f9e31e1: Docs treat permix as one landscape reason for PermDock, not a rejected PR stack.

## 0.1.0

### Minor Changes

- 258e0aa: Add `permdock/a2a` Agent Cards, per-caller extended cards, and `protectSkill` for A2A task execution.
- 176b15d: Add `crud`, `readable` and `writable` option factories that expand to the conventional `resource()` action lists and default meta.
- 4d379bd: Ship `permdock/ai-sdk` so decisions map to AI SDK 7 `toolApproval`, capability middleware and `needsApproval`.
- f9db032: Ship `permdock/approvals` so pending human gates live in a pluggable store with an in-memory default, Fetch approver routes, and `PermDock-Approval` resume helpers that never change `decide`.
- 42012ff: Add `simulate({ arazzo, openapi })` for Arazzo 1.1 workflows and `permdock arazzo check` for catalog holes (no subject).
- d73faab: Add `permdock/authzen`: a Fetch handler for AuthZEN evaluation, evaluations, search and discovery from a typed policy.
- 5da6630: Add `permdock/better-auth` with `subjectFromBetterAuth`, `betterAuthRoleSource` and `rolesFromAccessControl`.
- 7334398: Ship `permdock/claude-agent` so `canUseTool` and `PermissionRequest` hooks answer from one Decision.
- d4ba79e: Add `permdock/clerk` with `subjectFromClerk` for organization memberships, custom permissions and billing features.
- 4695aa9: Ship `@permdock/cli` with collect, catalog, usage, doctor and skills, plus collect-only Next and unplugin hooks.
- 6db339d: Add `permdock/cloud`: `cloud({ url, key })` returning Cloud `approvals`, `sink` and `snapshots` over fetch.
- 337aeba: Fail-closed async `context` and schema-aware `fields` grants with `permdock.pick`.
- 3fbb22e: Add `permdock/convex` with `withPermDock` and `snapshotQuery` for Convex functions.
- 89aad52: Add `signDecisionBatch` and a `signer` option on `memorySink` so each write can export as `typ: permdock-decisions+jwt`.
- cb31397: Add `permdock/elysia` wrapping the Fetch kernel as a plugin with Problem Details and WWW-Authenticate.
- 7039b88: Ship `permdock/eve` with `approval`, `approvalFor` and a session-scoped `permdock` helper.
- 56a366a: Add `permdock/express` wrapping the Fetch kernel as middleware with Problem Details and WWW-Authenticate.
- 036049c: Add `permdock/fastify` wrapping the Fetch kernel as a plugin with Problem Details and WWW-Authenticate.
- 938d6ab: Ship `permdock/hono` as a thin Fetch-kernel wrapper with `protect` and the AuthZEN evaluations route.
- c4a13ce: Evaluate GNAP `delegation.access` against grants, map RFC 7662 / RFC 9767 introspection in `subjectFromIntrospection`, and reject a claimed `act` nest that does not verify (`invalid-chain`).
- 9a8930b: Ship `permdock/jwt` so bearer tokens become subjects through an optional `jose` peer, and add verifier/signer conformance runners plus signed-output fixtures.
- b24852e: Add `permdock/mcp`: `protectServer` guards MCP tools with typed permissions, scope step-up, filtered `list_tools`, and Decision-shaped refusals.
- 783414e: Add `permdock/nest` wrapping the Fetch kernel as a module, guard and Protect decorator with Problem Details and WWW-Authenticate.
- bcd49f1: Ship `permdock/next` so App Router apps resolve a request-scoped PermDock through an explicit factory.
- 294c62f: Add `permdock/node` wrapping the Fetch kernel for `node:http` with Problem Details and WWW-Authenticate.
- 6abc807: Ship `permdock/openai` with `needsApproval`, `guardTools`, `resolveInterruptions` and a request-scoped `permdock`.
- a7c3fb6: Add `permdock/openapi` and `permdock openapi emit` for OpenAPI 3.2 documents, Overlay 1.1/1.2, and the pinned 3.3 Security Profile draft.
- 2e6f61d: Add `permdock/orpc` middleware that maps the Fetch kernel onto oRPC so denials throw `ORPCError` with Problem Details as `data`.
- 54d4d6d: Add `permdock/otel` decision spans and counters, with an optional OpenTelemetry API and a structural logger fallback.
- 03600fc: Add `permdock/pdp` AuthZEN client and `providers` on `definePolicy`. Core stays synchronous and fails closed for delegated permissions.
- 9cd0590: Add the `permdock` core package (definitions, portable conditions, tenancy, `createPermDock`, snapshot v2) and `@permdock/testing` (policy matrix and core conformance runners).
- Thread `Policy` user and principal generics through core and every adapter `createPermDock` so a typed policy is accepted without a cast.
- Publish metadata, ranged optional peers (including `@opentelemetry/api`), and a provenance-enabled release workflow.
- 41d4112: Add quota grants with a pluggable `LimitStore`. `can` never consumes; a thenable or thrown store denies with `limit-unavailable`.
- 110804b: Add `permdock/react-native` with a persisted snapshot `storage` option so Expo Router guards can answer on the first frame.
- be63d85: Ship `permdock/react` so clients evaluate portable grants from a snapshot without a second policy copy.
- 1ff89ca: Add `permdock/scim`: RFC 7644 `/Users` and `/Groups` receiver, `DirectoryStore`, `directoryMembershipSource`, and `testDirectoryStore`.
- a674d93: Ship `permdock/server` as the Fetch kernel for Problem Details, approval resume, and AuthZEN evaluations.
- 586d01b: Ship the `wire-permdock` and `audit-permissions` consumer skills in the package.
- Rename the snapshot TypeScript type from `SnapshotV2` to `Snapshot`. The wire field `v` is unchanged.
- d9d216c: Add `permdock/solid` provider, accessor hooks and `<Protected>` with the same snapshot-backed client store as `permdock/react`.
- 70080a6: Add `permdock/ssf` CAEP receiver with `receiver.push`, `receiver.poll`, and OIDC Back-Channel Logout `receiver.logout`.
- 472642d: Add `permdock/supabase` with `subjectFromSupabase`, `supabaseRls` and `authorizeSql`.
- a3af6bb: Add `permdock/svelte` context, readable stores and `<Protected>` with the same snapshot-backed client store as `permdock/react`.
- 6d7d2c8: Add `permdock/terminal` for consumers' own CLIs: device-flow login, `filterCommands`, `--json` Problem Details, and agent-run actor tokens.
- d577232: Add `permdock/trpc` middleware that maps the Fetch kernel onto tRPC so denials throw `TRPCError` with Problem Details as `cause`.
- a194edb: Add `permdock/vue` plugin, composables and `<Protected>` with the same snapshot-backed client store as `permdock/react`.
- 1688b67: Verify Web Bot Auth (RFC 9421) in the Fetch kernel. A claimed signature that fails is rejected with `invalid-signature`; a verified signer becomes `actor.kind: 'web-bot-auth'`.
- 2d53152: Add `permdock/webmcp` `registerTools` so a page exposes only the WebMCP tools the current snapshot allows.
- 370c42d: Add `permdock/drizzle`, `permdock/prisma` and `permdock/kysely` `toWhere` compilers, including `memberOf`.

### Patch Changes

- 8f79c80: Document the docs-site decide explorer at `/devtools`. It is not a new React export.
- 5cb7864: Document the public docs MCP at `/mcp` (`search_docs`, `get_page`) so agents read current adapter pages.
- Boot agent examples without a model key and add a collect-checked monorepo example.
- c63761a: Add the drizzle example that compiles list and update grants with toWhere.
- 5e51bd4: Add the prisma example that compiles list and update grants with toWhere.
- fab063b: Add the supabase-rls example that maps claims through subjectFromSupabase.
