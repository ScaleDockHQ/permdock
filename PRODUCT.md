# PermDock — Product

This document is the product overview: what PermDock is, who it is for, what it must do, how it is built and in what order. Detail lives in the documentation tree under [`apps/docs/content/docs`](./apps/docs/content/docs) (Fumadocs-ready MDX) and is linked from each section. When the two disagree, the docs tree wins and this file gets fixed.

Version: Phase 4 in progress (September 2026). Phase 1–3 OSS has shipped (core, surface adapters, `@permdock/cli`, data compilers, SSF, providers). In-repo AuthZEN conformance covers Basic, Batch, Search and Discovery shapes; **external AuthZEN certification is the remaining 1.0 gate**. The marketing app is the Vercel Service at `/`; the Fumadocs app is the docs service at `/docs`. Packages version toward `0.1.0`.

## 1. Vision and positioning

**Tagline.** Typed permissions for TypeScript apps, APIs, databases, and AI agents.

**One-liner.** Define permissions once as typed references over the Zod / Valibot / ArkType schemas you already have; grant them to roles with portable conditions; check them in React, React Native, Next.js, Hono, tRPC and MCP servers; compile the same conditions to SQL `where` clauses and Postgres RLS policies; drive tool approvals in the Vercel AI SDK and Claude Agent SDK from the same decision.

**Why now.** Three things changed in 2025–2026: TypeScript 7 made template-literal-union permission keys expensive and brittle; Next.js 16.3 Instant Navigations made blocking permission checks a visible UX regression; and AI agents started calling tools on users' behalf, with the MCP authorization spec, AuthZEN 1.0, OAuth agent-delegation drafts, Shared Signals / CAEP and the OWASP Agentic Top 10 all landing within twelve months. No TypeScript permissions library was designed for any of the three. PermDock is.

**Origin.** PermDock is a greenfield, clean-room library. permix, CASL, Kilpi and the rest of the TypeScript permissions landscape are why it exists: closest in adapter breadth, but none of them combine typed references, portable conditions, structured decisions and a request-scoped core. It copies none of their naming or API surface ([landscape](./apps/docs/content/docs/research/landscape.mdx), [permix lessons](./apps/docs/content/docs/research/permix-lessons.mdx)).

## 2. Target users

1. **TypeScript product teams** shipping Next.js / React / React Native apps with a Postgres (often Supabase) backend, who currently maintain permission logic in three places (UI, API, RLS) and want one.
2. **API and MCP server authors** who need per-tool / per-route authorization with step-up scopes, OpenAPI security output and machine-readable denials.
3. **Teams building agents** on the Vercel AI SDK or Claude Agent SDK who need "ask the user first" as a first-class outcome, per-tool least privilege and an audit trail.
4. **Coding agents** working in those repos. Every doc page, skill and error message is written so an agent can wire PermDock end-to-end without reading source ([for AI agents](./apps/docs/content/docs/for-ai-agents.mdx)).

## 3. Design principles

| Principle | Meaning | Where it shows |
| --- | --- | --- |
| Typed references | Permissions are objects, never strings, in the public API | [permissions](./apps/docs/content/docs/concepts/permissions.mdx), [ADR 0003](./apps/docs/content/docs/decisions/0003-reference-based-permissions.mdx) |
| Policy as data | Roles are arrays of `allow` / `deny` grants with a JSON condition AST | [policies](./apps/docs/content/docs/concepts/policies.mdx), [ADR 0010](./apps/docs/content/docs/decisions/0010-policy-as-data-portable-conditions.mdx) |
| Portable-first | A condition must work in memory, in the browser, in SQL and in RLS; closures are a branded escape hatch | [conditions](./apps/docs/content/docs/concepts/conditions.mdx) |
| Immutable | `createPermDock` returns a frozen, request-scoped object | [ADR 0006](./apps/docs/content/docs/decisions/0006-explicit-factory-not-plugin.mdx) |
| Explainable | `decide()` returns a discriminated `Decision` with reasons, alternatives and a replay-safe token | [decisions](./apps/docs/content/docs/concepts/decisions.mdx), [ADR 0007](./apps/docs/content/docs/decisions/0007-decide-not-explain.mdx) |
| Fail-closed | Missing grant, unknown role, invalid input, unrecognised remote decision: all deny | [threat model](./apps/docs/content/docs/security/threat-model.mdx) |
| Standards-first | AuthZEN, OpenAPI 3.2 (Overlay output, with Overlay 1.2 built from the pinned draft behind `--overlay 1.2`; 3.3 Security Profiles built from the pinned draft behind `--target 3.3`, [ADR 0025](./apps/docs/content/docs/decisions/0025-draft-protocol-posture.mdx)), Standard Schema, RFC 9457, RFC 9396, FAPI 2.0, SSF/CAEP, MCP, WebMCP, A2A; a maintained [watch list](./apps/docs/content/docs/standards/watch-list.mdx) for in-progress OpenID / IETF work | [standards](./apps/docs/content/docs/standards/index.mdx) |
| Authentication upstream | PermDock consumes verified material only; `permdock/jwt` and provider `subjectFrom*` helpers verify, core never does | [authentication](./apps/docs/content/docs/concepts/authentication.mdx), [ADR 0018](./apps/docs/content/docs/decisions/0018-authentication-is-upstream.mdx) |
| Delegation-aware | Subject = principal + actor + delegation; an agent never exceeds its user | [subject](./apps/docs/content/docs/concepts/subject.mdx), [ADR 0012](./apps/docs/content/docs/decisions/0012-two-principal-subject.mdx) |
| Agent-readable | Skills, `AGENTS.md`, `llms.txt`, JSON Schema catalog, model-readable denials | [agent docs standards](./apps/docs/content/docs/standards/agent-docs-standards.mdx) |
| Small | ESM-only, zero runtime deps in core; gzip size measured, then baselined | [ADR 0015](./apps/docs/content/docs/decisions/0015-no-runtime-deps-in-core.mdx), [ADR 0020](./apps/docs/content/docs/decisions/0020-measure-bundle-size-then-set-a-baseline.mdx) |

## 4. Differentiators

1. **Reference-based permissions.** `permissions.post.update` is a typed object carrying key, scope, schema and metadata. Go-to-definition, rename-safe, no template-literal unions (TS7-friendly), autocomplete through the object graph, and the runtime definition is the catalog.
2. **Standard-Schema-native.** Resources from any Standard Schema validator; instance types inferred; runtime validation at trust boundaries (`validate: 'boundary'` default); Standard JSON Schema powers OpenAPI and catalog export.
3. **Policy as data.** Roles are arrays of `allow` / `deny` grants with portable conditions (`where` / `check`). One condition evaluates to a boolean in the UI, filters arrays, compiles to Drizzle / Prisma / Kysely `where`, and generates Postgres RLS.
4. **Immutable, request-scoped instances.** `createPermDock(policy, user)` returns a frozen `PermDock`; one name in every adapter, the import path names the framework.
5. **Decisions, not booleans.** `decide()` returns a discriminated `Decision`; `assert()` narrows the subject; `on('decision')` feeds audit; adapters emit RFC 9457 Problem Details and model-readable MCP refusals.
6. **Snapshots that carry conditions.** Clients answer ownership checks offline; scoped per feature for large policies; no client-side rule duplication.
7. **Non-blocking UI.** `usePermission()` returns `{ allowed, status }`; `<Protected>` renders the shell immediately; the Next.js adapter is built for Cache Components + Partial Prefetching; React Native persists snapshots for `Stack.Protected`.
8. **Scales from one file to a monorepo.** Colocated `definePermissions()` per feature, `mergePermissions()` with identity-preserving leaves, role fragments merged by name, `permdock collect` as a compile output (next-intl `useExtracted` model), generated definitions from RLS or OpenAPI.
9. **MCP tool authorization.** `permission` on `registerTool` → `scopeChallenge` step-up, per-caller `list_tools` filtering, args validated against the resource schema, refusals carrying Decision reasons.
10. **OpenAPI 3.2 in and out, composed with the toolchain.** Emit `securitySchemes`, per-operation `security`, `x-permdock-permissions`, as a mutated document or an [OpenAPI Overlay](./apps/docs/content/docs/standards/openapi-overlay.mdx); registered `x-oai-deprecated` / `x-oai-deviceAuthorization` / `x-oai-deviceAuthorizationUrl` fallbacks and `x-permdock-oauth2MetadataUrl` for 3.1; `--target 3.3` (experimental) emits the pinned OpenAPI 3.3 Security Profile draft (`type: profile` scheme, `securityProfileRequirements`) next to `x-permdock-securityProfile`, with the pin recorded in `x-permdock-catalog.drafts`; in-process hooks for hono-openapi, `@hono/zod-openapi`, oRPC, trpc-to-openapi, Elysia, Fastify, Nest; the Overlay for producers without a hook (next-openapi-gen for Next.js and the frameworks it scans), applied by next-openapi-gen, Redocly CLI, Bump.sh, Speakeasy or `overlays-js`, consumed unchanged by Hey API, Orval, Kubb, Scalar, Mintlify, Fern and OpenAPI-to-MCP bridges, checked at runtime by Schemathesis `ignored_auth` and for breaking changes by oasdiff; no wrapper packages ([0023](./apps/docs/content/docs/decisions/0023-compose-openapi-ecosystem.mdx), [research](./apps/docs/content/docs/research/openapi-ecosystem.mdx), [ecosystem index](./apps/docs/content/docs/research/ecosystem-index.mdx)); import a doc into a catalog; `simulate()` over [Arazzo](./apps/docs/content/docs/standards/arazzo.mdx) workflows later.
11. **RLS round-trip.** `permdock rls generate | import | verify` for Supabase, Neon and generic Postgres; Drizzle `pgPolicy`, raw SQL and Prisma 8 targets; parity tests.
12. **Universal Fetch-first server kernel** → thin, typed adapters for Hono, Express, Fastify, Elysia, Nest, Node, tRPC, oRPC; plus `permdock/terminal` for consumers' own CLIs (device-flow login, `filterCommands`, `--json` Problem Details, agent-run mode).
13. **Bring-your-own-auth providers.** `permdock/jwt` (JWKS or OIDC Discovery, RFC 8725 checks, FAPI 2.0 `profile: 'fapi2'`, DPoP / mTLS binding, pluggable `TokenVerifier`), Supabase (custom access token hook, `getClaims()`), Better Auth, Clerk, Convex, HTTP PDP. Verification never lives in core.
14. **Agent-native.** Skills (`wire-permdock`, `audit-permissions`) in the package and on skills.sh, `AGENTS.md` with `CLAUDE.md` symlink, `llms.txt` and `.md` per docs page, docs MCP server, JSON Schema catalog, `permdock doctor`, deterministic codegen, docs written as MDX from day one.
15. **Modern toolchain.** ESM-only, zero runtime deps in core, TS 5.9/6/7 with `isolatedDeclarations` and `erasableSyntaxOnly`, per-entry gzip measured after core ships then used as the regression baseline, Oxlint / Oxfmt, Vitest type tests, `publint` + `arethetypeswrong`.
16. **Secure defaults.** Fail-closed, deny overrides allow, unknown reference = type error, prototype-safe, no eval, `service_role` never emitted, model-supplied subjects never trusted.
17. **Agent-runtime approvals.** One `Decision` drives AI SDK 7 `toolApproval` / capability middleware / `WorkflowAgent` `needsApproval`, Claude Agent SDK `canUseTool`, and MCP elicitation; `approval: 'human'` grants, replay-safe `token`, `alternatives` for self-correction, `simulate()` pre-flight for plans.
18. **Delegation-aware.** Principal + actor + delegation subject; RFC 9396 `authorization_details` per permission; works behind MCP Enterprise-Managed Authorization and agent delegation chains.
19. **Standards-native decision plane.** AuthZEN 1.0 endpoint and PEP client (certification target), SSF/CAEP receiver for continuous evaluation, OpenAPI 3.2 security output, A2A Agent Card security, WebMCP tool gating; OWASP Agentic Top 10 (ASI02 / ASI03) mapped to concrete mitigations.
20. **Pluggable approvals and an optional Cloud.** Pending approvals live in an `ApprovalStore` (`permdock/approvals`, in-memory default, `approvalsHandler` for approvers, `PermDock-Approval` header for HTTP resume); audit goes to a `DecisionSink`. Eve and the OpenAI Agents SDK join AI SDK, Claude Agent SDK and MCP as runtimes driven by one `Decision`. PermDock Cloud implements the same interfaces, leading with the decision log sold as compliance evidence and agent governance, then a hosted AuthZEN Authorization Decision Service, an approval inbox and a SCIM relay into a `DirectoryStore` the application owns (`permdock/scim`); every `DecisionSink` receives every event by default; nothing requires the Cloud and it never decides ([ADR 0021](./apps/docs/content/docs/decisions/0021-embedded-pdp-hosted-ads.mdx), [ADR 0022](./apps/docs/content/docs/decisions/0022-approvals-are-pluggable.mdx), [ADR 0027](./apps/docs/content/docs/decisions/0027-governance-first-cloud.mdx)).

### Competitor summary

| Library | Strength | Gap PermDock fills | Research |
| --- | --- | --- | --- |
| CASL v7 | Conditions → Prisma / Mongoose `where`, field rules, ~1.4M weekly downloads | String tuples, no Standard Schema, no SSR / RN / MCP / OpenAPI | [casl-v7](./apps/docs/content/docs/research/casl-v7.mdx) |
| permix v4 | Adapter breadth | Mutable global core, boolean hydration, no explain | [permix-lessons](./apps/docs/content/docs/research/permix-lessons.mdx) |
| Kilpi v1 | Server-first async policies, `Grant` / `Deny`, RSC `<Access>` | zod + superjson in core, no Standard Schema / RN / MCP / OpenAPI, single maintainer | [kilpi-v1](./apps/docs/content/docs/research/kilpi-v1.mdx) |
| `@zap-studio/permit` v2 | Standard Schema resources, ~2.8 kB, fail-closed | Boolean-only, sync-only rules, no adapters | [zap-studio-permit](./apps/docs/content/docs/research/zap-studio-permit.mdx) |
| Better Auth AC | RBAC bound to Better Auth sessions | No conditions / snapshots / adapters; PermDock layers on top | [landscape](./apps/docs/content/docs/research/landscape.mdx) |
| Cerbos, Permit.io, OpenFGA, SpiceDB, Oso Cloud | Hosted PDPs, policy languages, relation graphs | Strings in, boolean out; not embeddable as a typed TS library; PermDock bridges via AuthZEN / `pdp` and offers the same operational layer (approvals, decision log, hosted ADS) as an optional Cloud | [landscape](./apps/docs/content/docs/research/landscape.mdx), [commercial-landscape](./apps/docs/content/docs/research/commercial-landscape.mdx) |
| Arcade, Composio, Permit MCP Gateway, Oso for Agents | Agent tool-auth proxies with human approval | Sit between agent and tool as a network hop; string tool names; PermDock binds per tool inside the server with a typed decision and a pluggable approval store | [commercial-landscape](./apps/docs/content/docs/research/commercial-landscape.mdx) |
| ZenStack v3 | Policies compiled to SQL | Dropped DB-free `check()` | [landscape](./apps/docs/content/docs/research/landscape.mdx) |
| `@ai-sdk/policy-opa` | Reference AI SDK policy adapter | Rego, fails open on unrecognised decisions | [agent-standards-2026](./apps/docs/content/docs/research/agent-standards-2026.mdx) |
| Cedar / AWS Verified Permissions, OPA / Rego, Casbin, `accesscontrol` | General policy engines and languages | Separate policy language, no typed references, no Standard Schema or agent approvals; PermDock is a PEP in front of them | [landscape](./apps/docs/content/docs/research/landscape.mdx) |
| Zanzibar family (OpenFGA, SpiceDB, Auth0 FGA, WorkOS FGA) | Relationship graphs at scale | Not embeddable; PermDock bridges via a provider for relation lookups | [landscape](./apps/docs/content/docs/research/landscape.mdx) |

Full matrix: [comparison](./apps/docs/content/docs/comparison.mdx).

## 5. Feature scope

**Must (v0.1, Phase 1)**

- `definePermissions` / `resource` / `crud` / `readable` / `writable` / nested groups / `id` field / action metadata; `mergePermissions`, `listPermissions`, `findPermission`.
- `definePolicy` / `role` / `allow` / `deny` / `subject` / `context` / `validate`; role fragments merged by name; `approval: 'human'`; `allow` / `deny` over arrays of references.
- Multi-tenant roles ([ADR 0024](./apps/docs/content/docs/decisions/0024-scoped-roles-and-memberships.mdx), [tenancy](./apps/docs/content/docs/concepts/tenancy.mdx)): `principal.memberships` and the active `principal.tenant`; scoped roles (`role(name, grants, { on: 'tenant' | 'team' | resource, assignable })`), `definePolicy({ scopes })`, `resource({ parent })` for resource-role derivation; tenant-defined custom roles as data through `RoleSource` and `MembershipSource` (in-process defaults shipped); the `memberOf` condition node; reasons `tenant-mismatch`, `no-membership`, `scope`, `expired-membership`; `tenant()` / `team()` derived instances and `memberships()`, `tenants()`, `heldRoles()`, `assignableRoles()` introspection.
- Portable condition AST with in-memory evaluator; closures as branded non-portable grants.
- Two-principal subject (`principal`, `actor`, `delegation`); every `subjectFrom*` typed as a `SubjectResolver` with a Standard Schema `schema` option for custom claims; RFC 9068 `roles` / `groups` / `entitlements` mapping in `permdock/jwt` ([extension interfaces](./apps/docs/content/docs/concepts/extension-interfaces.mdx), [JWT authorization claims](./apps/docs/content/docs/standards/jwt-authorization-claims.mdx)).
- `createPermDock` with `can`, `decide` (three outcomes), `assert`, `filter`, `simulate` (with `{ roles, memberships, tenant }` previews), `snapshot` (v2: memberships, tenant, `tenants`, `simulated`), `on`; `describe(decision)`.
- Standard Schema validation in `boundary` mode; `PermDockValidationError`.
- AuthZEN-shaped decision endpoint and batched client.
- `permdock/react` (`usePermission`, `usePermissions`, `useFilter`, `useTenant`, `useMemberships`, `useRoles`, `useAssignableRoles`, `useApproval`, `useSubject`, `<Protected>`; [UI](./apps/docs/content/docs/concepts/ui.mdx)), `permdock/next` (Cache Components, explicit factory), Fetch kernel + `permdock/hono`, `permdock/jwt` (`subjectFromJwt`, JWKS or OIDC `discovery`, `typ` / `accept`, RFC 9864 algorithm allow-list, `jose` optional peer, `profile: 'fapi2'`), `permdock/ai-sdk`, `permdock/claude-agent`, `permdock/eve`, `permdock/openai`, `@permdock/testing`.
- Spec-aligned Subject and errors ([ADR 0026](./apps/docs/content/docs/decisions/0026-spec-aligned-naming.mdx)): `principal.issuer`, `principal.assurance` (`acr`, `amr`, `authTime`), `subject.session`, `binding` as RFC 7800 `cnf` members; `on('auth')` `reason: 'invalid-token'` with a `cause`; HTTP adapters emit RFC 6750 / RFC 9470 `WWW-Authenticate` from the reason ([OpenID Connect](./apps/docs/content/docs/standards/openid-connect.mdx), [JOSE](./apps/docs/content/docs/standards/jose.mdx)).
- `TokenVerifier` and `TokenSigner` interfaces (`joseTokenVerifier`, `joseTokenSigner`, conformance runners); JWS-signed snapshots (`permdock-snapshot+jwt`) and the optional signed approval token (`permdock-approval+jwt`), verifiable by any JOSE library in any language ([wire formats](./apps/docs/content/docs/concepts/wire-formats.mdx)).
- `permdock/approvals` (`ApprovalStore`, `memoryApprovalStore`, `approvalsHandler`, `PermDock-Approval` resume header) and `DecisionSink` with `memorySink`.
- Skills, `AGENTS.md`, `llms.txt`; examples `next`, `react-vite`, `hono`, `ai-sdk-agent`, `claude-agent`, `eve-agent`, `openai-agent`; `tests/types` TS matrix. The docs app was scaffolded in Phase 0.
- `@permdock/cli`: `collect`, `catalog`, `usage`, `doctor`, `skills`; `createPermDockPlugin` (`permdock/next/plugin`) and `createPermDockUnplugin` (`@permdock/cli/unplugin`) as collect-only build hooks.
- `tests/e2e`: Playwright smoke of every example (granted and denied paths). Plain Playwright; `@next/playwright` `instant()` is not in the pinned Next.js.

**Should (v0.2–0.9, Phases 2–3)**

- `permdock/mcp` (scopeChallenge, EMA, elicitation), `permdock/authzen` full endpoint set + certification run, `permdock/openapi` (3.2 document and Overlay, `--overlay 1.2` with the pinned Overlay 1.2 draft, `--target 3.3` with the pinned Security Profile draft, `x-permdock-` namespace registration), `permdock/react-native`, `permdock/express`, `permdock/fastify`, `permdock/elysia`, `permdock/nest`, `permdock/node`, `permdock/trpc`, `permdock/orpc`, `permdock/vue`, `permdock/svelte`, `permdock/solid`, `permdock/terminal`, `permdock/webmcp`, `permdock/a2a`, `permdock/otel`, `permdock/scim` — shipped.
- CLI `openapi --format overlay --check` plus a Spectral / Redocly / vacuum ruleset file; example per adapter plus `monorepo` and `terminal`; Playwright e2e per example.
- Signed decision-batch export (`permdock-decisions+jwt`) as a `DecisionSink` `signer` option (`memorySink({ signer })`, `signDecisionBatch`) — shipped.
- `permdock/cloud` (shipped optional client: `cloud({ url, key })` → `approvals`, `sink`, `snapshots` over HTTP; never `MembershipSource` / `RoleSource`); PermDock Cloud alpha in the separate `PermDock-Cloud` repo, in order: decision log with access-review queries and signed / OCSF / CSV evidence exports, hosted AuthZEN ADS, approval inbox, hosted SCIM relay replaying into the application's `scimHandler`, integrations catalog (trusted issuers, CAEP transmitters, OTLP, OCSF, CloudEvents webhooks, compliance platforms, Chat SDK delivery, read-only MCP server); Vercel Marketplace listing with `eve-agent` as the template.
- `permdock.where` compilers for Drizzle, Prisma, Kysely (including `memberOf`) — shipped; `permdock rls generate | import | verify` with membership-table mappings — shipped; `permdock/supabase` (`subjectFromSupabase` with tenant and memberships claims, `authorize()` scaffold) — shipped; async `context` and schema-aware field-level grants (`fields`, `pick`) — shipped; `permdock/ssf` (CAEP receiver plus OIDC Back-Channel Logout `logout_token`) — shipped; `tests/integration` RLS parity suite on Postgres via testcontainers — shipped; examples `supabase-rls`, `drizzle`, `prisma` — shipped.

**Later (v1.0 gate)**

Phase 4 OSS (providers, quotas, Web Bot Auth, introspection, Arazzo `simulate`, docs MCP, unplugin recipes) has shipped. `1.0.0` waits on **external AuthZEN certification**; in-repo tests already cover Basic, Batch, Search and Discovery request shapes. Tracked, not built: GNAP `access` as a new delegation input and a GNAP OpenAPI scheme (name reserved). Every other draft PermDock follows carries a build / name / track posture on the [watch list](./apps/docs/content/docs/standards/watch-list.mdx) ([ADR 0025](./apps/docs/content/docs/decisions/0025-draft-protocol-posture.mdx)).

**Non-goals**

- Requiring a network call to decide: PermDock is a PDP you embed, PermDock Cloud is optional, and every hosted capability has an in-process default behind the same interface ([ADR 0021](./apps/docs/content/docs/decisions/0021-embedded-pdp-hosted-ads.mdx)).
- A policy DSL, replacing authentication, issuing tokens, or Zanzibar-scale relation graphs (bridge to OpenFGA / SpiceDB via a provider; resource roles follow declared, finite `parent` chains only).
- Tenant, team, invitation, membership or custom-role storage and management; PermDock reads them through `MembershipSource` and `RoleSource`, the auth provider or the app owns the tables ([ADR 0024](./apps/docs/content/docs/decisions/0024-scoped-roles-and-memberships.mdx)).
- UI components beyond `<Protected>`; hooks return data, the design system renders it.

## 6. Adapter × example × phase matrix

| Adapter | Import path | Example app (`apps/examples/`) | Phase |
| --- | --- | --- | --- |
| React | `permdock/react` | `react-vite` | 1 |
| React Native / Expo Router | `permdock/react-native` | `expo` | 2 |
| Next.js 16.3 | `permdock/next` | `next` | 1 |
| Vue / Svelte / Solid | `permdock/vue` `permdock/svelte` `permdock/solid` | `vue` `svelte` `solid` | 2 |
| Server kernel | `permdock/server` | — | 1 |
| Hono | `permdock/hono` | `hono` | 1 |
| Express / Fastify / Elysia / Nest / Node | `permdock/express` … `permdock/node` | `express` `fastify` `elysia` `nest` | 2 |
| Terminal (your own CLI) | `permdock/terminal` | `terminal` | 2 |
| tRPC / oRPC | `permdock/trpc` `permdock/orpc` | `trpc` `orpc` | 2 |
| MCP | `permdock/mcp` | `mcp-server` | 2 |
| AI SDK | `permdock/ai-sdk` | `ai-sdk-agent` | 1 |
| Claude Agent SDK | `permdock/claude-agent` | `claude-agent` | 1 |
| Eve | `permdock/eve` | `eve-agent` (also the Marketplace template) | 1 |
| OpenAI Agents SDK | `permdock/openai` | `openai-agent` | 1 |
| WebMCP | `permdock/webmcp` | `webmcp` | 2 |
| A2A | `permdock/a2a` | `a2a-agent` | 2 |
| AuthZEN | `permdock/authzen` | `authzen-pdp` | 2 |
| Approvals (store, handler) | `permdock/approvals` | (via `ai-sdk-agent`, `eve-agent`, `openai-agent`, `terminal`) | 1 |
| Cloud client | `permdock/cloud` | `eve-agent` | 2 |
| SCIM receiver (`DirectoryStore`, `directoryMembershipSource`) | `permdock/scim` | `scim` | 2 |
| SSF / CAEP | `permdock/ssf` | — | 3 |
| OpenAPI 3.2 (document / Overlay) | `permdock/openapi` | (via `hono`, `orpc`, `trpc`; `next` via next-openapi-gen + Overlay) | 2 |
| OpenTelemetry | `permdock/otel` | — | 2 |
| Drizzle / Prisma / Kysely | `permdock/drizzle` `permdock/prisma` `permdock/kysely` | `drizzle` `prisma` | 3 |
| RLS | `permdock rls` (CLI) | `supabase-rls` | 3 |
| JWT / JWKS | `permdock/jwt` | (via `hono`, `mcp-server`) | 1 |
| Supabase | `permdock/supabase` (`subjectFromSupabase`, tenant and memberships claims, `authorize()` scaffold) | `supabase-rls` | 3 |
| Better Auth / Clerk / Convex | `permdock/better-auth` (`betterAuthRoleSource`) `permdock/clerk` (`memberships: 'all'`, custom roles) `permdock/convex` | `better-auth` `clerk` `convex` | 4 |
| PDP client | `permdock/pdp` | — | 4 |
| Testing | `@permdock/testing` | — | 1 |
| Monorepo pattern | `mergePermissions` + `permdock collect --check` | `monorepo` | 2 |

**Shared kernel contract.** Every server adapter wraps `permdock/server`: resolve the subject from the framework's request object, `createPermDock` once per request, expose `protect(permission, loadData)`, validate boundary data against the resource schema, and turn `denied` into a 403 `application/problem+json` body and `approval-required` into a 403 with the `.../approval-required` type. Details: [server kernel](./apps/docs/content/docs/adapters/server-kernel.mdx), [adapter matrix](./apps/docs/content/docs/adapters/index.mdx).

## 7. Standards alignment

| Standard | Use | Page |
| --- | --- | --- |
| Standard Schema v1 + Standard JSON Schema | Resource definitions, inference, boundary validation, catalog | [standard-schema](./apps/docs/content/docs/standards/standard-schema.mdx) |
| OpenAPI 3.2 | Security output and import, registered `x-oai-*` fallbacks, `x-permdock-*` extensions | [openapi-3-2](./apps/docs/content/docs/standards/openapi-3-2.mdx), [openapi-registry](./apps/docs/content/docs/standards/openapi-registry.mdx) |
| OpenAPI Overlay 1.1 (and the pinned 1.2 draft), Arazzo 1.1, OpenAPI 3.3 (built from the pinned Security Profile draft) | Overlay as the preferred `permdock openapi` output, `--overlay 1.2` emitting the pinned reusable-actions draft with 1.1.0 as default; `simulate({ arazzo, openapi })` and `permdock arazzo check` ([0036](./apps/docs/content/docs/decisions/0036-arazzo-simulate.mdx)); `--target 3.3` emits the pinned 3.3 Security Profile draft with `x-permdock-securityProfile` as twin and switches to the released construct at 3.3.0 | [openapi-overlay](./apps/docs/content/docs/standards/openapi-overlay.mdx), [arazzo](./apps/docs/content/docs/standards/arazzo.mdx), [openapi-3-3](./apps/docs/content/docs/standards/openapi-3-3.mdx) |
| RFC 9068 `roles` / `groups` / `entitlements`, SCIM 2.0 group encoding, NIST RBAC (INCITS 359) vocabulary | `permdock/jwt` default claim mapping to global roles and team memberships; ids never display names; RBAC terms in the docs | [jwt-authorization-claims](./apps/docs/content/docs/standards/jwt-authorization-claims.mdx) |
| SCIM 2.0 (RFC 7643, RFC 7644, RFC 9865 cursor pagination), RFC 7523 JWT bearer | `permdock/scim` receiver for `/Users` and `/Groups` writing a `DirectoryStore` the application owns; `urn:permdock:scim:schemas:extension:roles:1.0` on `Group`; the PermDock Cloud relay authenticates with an RFC 7523 assertion | [scim](./apps/docs/content/docs/standards/scim.mdx) |
| FAPI 2.0 Security Profile, RFC 8725 / rfc8725bis, DPoP, mTLS | `permdock/jwt` `profile: 'fapi2'`, sender-constrained tokens as `binding` | [fapi-2](./apps/docs/content/docs/standards/fapi-2.mdx) |
| OpenID Connect Core 1.0, Discovery 1.0, RFC 8414, RFC 9470, Back-Channel Logout | `subjectFromJwt({ discovery })`; `iss` + `sub` as identity, `acr` / `amr` / `auth_time` as `principal.assurance`, `sid` as `subject.session`; step-up denials as `insufficient_user_authentication`; `logout_token` as a revocation input | [openid-connect](./apps/docs/content/docs/standards/openid-connect.mdx) |
| JOSE: JWT, JWS, JWE, JWK, JWA (RFC 7515–7519, RFC 8037, RFC 9864), RFC 9068 `at+jwt` | Everything `permdock/jwt` consumes and everything PermDock signs (`permdock-snapshot+jwt`, `permdock-approval+jwt`, `permdock-decisions+jwt`) is compact JWS with registered names, verifiable by any JOSE library | [jose](./apps/docs/content/docs/standards/jose.mdx) |
| GNAP (RFC 9635), transaction tokens, WIMSE, IPSIE, OpenID Federation (tracking) | `delegation.access`, workload principals, enterprise checklist; see the watch list | [gnap](./apps/docs/content/docs/standards/gnap.mdx), [watch-list](./apps/docs/content/docs/standards/watch-list.mdx) |
| MCP authorization 2026-07-28 | scopeChallenge, CIMD, RFC 9207, EMA / ID-JAG, elicitation | [mcp-authorization](./apps/docs/content/docs/standards/mcp-authorization.mdx) |
| OpenID AuthZEN 1.0 | Decision endpoint wire format, PEP client, certification | [authzen](./apps/docs/content/docs/standards/authzen.mdx) |
| RFC 9396, RFC 8693, DPoP, agent delegation drafts | Delegation model, `authorization_details` | [oauth-agent-delegation](./apps/docs/content/docs/standards/oauth-agent-delegation.mdx) |
| SSF 1.0 / CAEP 1.0 | Real-time snapshot invalidation | [shared-signals-caep](./apps/docs/content/docs/standards/shared-signals-caep.mdx) |
| RFC 9457 Problem Details | HTTP denial bodies | [problem-details](./apps/docs/content/docs/standards/problem-details.mdx) |
| Postgres RLS | Generate / import / verify | [postgres-rls](./apps/docs/content/docs/standards/postgres-rls.mdx) |
| WebMCP, A2A 1.0, Web Bot Auth | Browser agents, agent cards, agent identity | [webmcp](./apps/docs/content/docs/standards/webmcp.mdx), [a2a](./apps/docs/content/docs/standards/a2a.mdx), [web-bot-auth](./apps/docs/content/docs/standards/web-bot-auth.mdx) |
| AGENTS.md, Agent Skills, llms.txt | Agent-facing docs | [agent-docs-standards](./apps/docs/content/docs/standards/agent-docs-standards.mdx) |

**RLS strategy.** A small portable condition subset round-trips between the app and Postgres (`eq(row.user_id, subject.id)` ↔ `(select auth.uid()) = user_id`); everything else becomes `opaque({ sql, fingerprint })`. Semantics mirror Postgres exactly (read → `SELECT USING`, create → `INSERT WITH CHECK`, update → `USING` + `WITH CHECK`, delete → `DELETE USING`; allow → PERMISSIVE, deny → RESTRICTIVE). Parity is verified per role in a real database. Details: [RLS adapter](./apps/docs/content/docs/adapters/rls.mdx), [RLS research](./apps/docs/content/docs/research/postgres-rls.mdx).

**Next.js 16.3 strategy.** The snapshot resolves from `"use cache: private"` so guards answer from the prefetched App Shell; anything data-dependent streams under Suspense; `updateTag` refreshes prefetches on role change. The example app smokes granted and denied UI with Playwright. Details: [next adapter](./apps/docs/content/docs/adapters/next.mdx), [research](./apps/docs/content/docs/research/nextjs-16-3-instant-navigation.mdx).

**AI-agent strategy.** One `Decision` type is translated into each runtime's approval vocabulary; never `not-applicable`; `approval-required` becomes AI SDK `user-approval`, `WorkflowAgent` `needsApproval`, Eve `"user-approval"`, an OpenAI Agents SDK interruption, MCP elicitation or an HTTP 403 resumed with `PermDock-Approval`; the pending approval lives in a pluggable `ApprovalStore`; `simulate()` pre-flights an agent's plan; denials carry `alternatives`; OWASP ASI02 / ASI03 mitigations are documented feature by feature. Details: [ai-sdk](./apps/docs/content/docs/adapters/ai-sdk.mdx), [claude-agent](./apps/docs/content/docs/adapters/claude-agent.mdx), [eve](./apps/docs/content/docs/adapters/eve.mdx), [openai](./apps/docs/content/docs/adapters/openai.mdx), [approvals](./apps/docs/content/docs/security/approvals.mdx), [owasp-agentic](./apps/docs/content/docs/security/owasp-agentic.mdx).

## 8. Engineering standards

- **Packages.** `permdock` (umbrella, subpath exports, zero runtime deps except `@standard-schema/spec`), `@permdock/cli` (`oxc-parser`, `pgsql-parser`), `@permdock/testing`.
- **Language.** TypeScript 5.9 / 6 / 7 in CI; `isolatedDeclarations`, `erasableSyntaxOnly`, `exactOptionalPropertyTypes`; ESM-only; no JSX in shipped `.mjs` (compiled).
- **Build and lint.** tsdown, Oxlint, Oxfmt; `publint` and `arethetypeswrong` on every package.
- **Tests.** Vitest unit + type tests, Playwright e2e across examples, testcontainers Postgres for RLS parity and providers, per-entry gzip measurements (`tests/bundle`; baseline set after core ships).
- **Repo.** pnpm workspaces + catalogs, Turborepo; `/packages`, `/apps` (docs + examples), `/tests`.
- **Releases.** Changesets (or Release Please) with conventional commits; every adapter entry has its own changelog section.
- **Security.** Fail-closed by construction; prototype-safe paths; no `eval` / `new Function`; server-only entries marked and tested against client bundling; `service_role` never emitted; decision endpoint behind real auth. See [threat model](./apps/docs/content/docs/security/threat-model.mdx).

Full ADR: [0016 repo layout and toolchain](./apps/docs/content/docs/decisions/0016-repo-layout-and-toolchain.mdx).

## 9. Governance

- **RFC-lite for public API changes.** Any change to exported identifiers, wire formats (permission leaf, condition, snapshot, AuthZEN mapping, Problem Details) or CLI flags starts as an issue using the RFC template (context, proposal, alternatives, migration) and is recorded as an ADR under `decisions/` when accepted.
- **Adapter contribution template.** An adapter PR ships the entry, its docs page (`adapters/<name>.mdx` with `Status` / `Phase`), a skill reference update, an example app under `apps/examples/<name>`, tests and a `tests/bundle` measurement. See [`AGENTS.md`](./AGENTS.md).
- **Response-time targets.** Triage issues within 3 business days; security reports acknowledged within 48 hours; API RFCs decided within 2 weeks.
- **Decision log.** `apps/docs/content/docs/decisions/` is append-only; superseded ADRs are marked, not deleted.

## 10. Roadmap

| Phase | Version | Theme | Contents |
| --- | --- | --- | --- |
| 0 | — | Plan and docs | README, PRODUCT, AGENTS, MIT LICENSE, full MDX docs tree (concepts, adapters, standards, security, research, decisions), Fumadocs app as the first Vercel Service at `/docs` |
| 1 | v0.1 | Core + agents | Definitions, policies, portable conditions, two-principal subject with memberships and scoped roles (`RoleSource`, `MembershipSource`, snapshot v2), `createPermDock`, boundary validation, AuthZEN-shaped endpoint, `react`, `next`, kernel + `hono`, `jwt`, `ai-sdk`, `claude-agent`, `eve`, `openai`, `approvals` (+ `DecisionSink`), `@permdock/testing`, `@permdock/cli` (`collect`, `catalog`, `usage`, `doctor`, `skills`, collect-only plugins), skills, seven examples, TS matrix |
| 2 | v0.2–0.5 | Surfaces | `mcp`, `authzen` (+ certification), `openapi` (document + Overlay, `--overlay 1.2` pinned Overlay draft, `--target 3.3` pinned Security Profile draft), `react-native`, remaining HTTP / RPC / UI adapters, `terminal`, `webmcp`, `a2a`, `otel`, `scim`, `cloud` client, signed decision-batch export, CLI `openapi`, example per adapter + `monorepo` + `terminal` + `scim`, e2e; PermDock Cloud alpha (separate repo: decision log and evidence exports, hosted ADS, inbox, SCIM relay, integrations catalog) and Vercel Marketplace listing |
| 3 | v0.6–0.9 | Data | `where` compilers (with `memberOf`), `permdock rls` with membership-table mappings, `supabase`, async `context` and field-level grants (`fields`, `pick`), `ssf`, integration parity suite, data examples |
| 4 | v1.0 | Ecosystem | `better-auth` and `clerk` (memberships, `RoleSource` implementations), `convex`, `pdp`, quotas, Web Bot Auth, delegation-chain verification, Arazzo `simulate`, more frameworks, docs MCP server, devtools |

Detail: [roadmap](./apps/docs/content/docs/roadmap.mdx).

## 11. Versioning

- `0.x`: minor versions may change public API only through the RFC-lite process with a migration note; patch versions never do.
- `1.0`: when Phase 4 lands **and** AuthZEN is **externally certified** (in-repo conformance already covers Basic, Batch, Search and Discovery); from then on semver strictly, wire formats versioned separately (`snapshot v1`, catalog `$schema` URL).
- Subpath entries share the package version; an adapter marked `experimental` in its docs page may change in minors.
- TypeScript support window: current stable and the two previous majors that the matrix covers (5.9, 6, 7 today).

## 12. Success metrics

- Adoption: npm downloads, GitHub stars, example-app forks; at least one production case study per adapter group by v1.0.
- Agent time-to-first-check: a coding agent with the `wire-permdock` skill gets a passing `permdock doctor` in a fresh Next.js app in under 10 minutes.
- Bundle: per-entry gzip measured in `tests/bundle`; a regression budget is set from the Phase 1 baseline, not from a guessed 3 kB cap.
- Quality: 95% coverage on core; zero open P0 security issues; TS 5.9 / 6 / 7 green.
- Issue SLAs: triage 3 business days, security acknowledgement 48 hours.
- Interop: AuthZEN certification (Basic, Batch, Search, Discovery) by the end of Phase 2.

## 13. Open questions

Tracked in [roadmap](./apps/docs/content/docs/roadmap.mdx); resolved items become ADRs.

1. Resolved: `explain` is not an alias of `decide`; call `decide` then `describe` ([ADR 0028](./apps/docs/content/docs/decisions/0028-synchronous-evaluation.mdx)).
2. `<Protected>` vs a second `<Can>`-style inline render-prop component.
3. Resolved: `principal` is a typed reference builder (`principal.id`, `context.teamIds`) that produces `{ ref: 'principal.<path>' }`; `subject` remains a deprecated alias ([ADR 0040](./apps/docs/content/docs/decisions/0040-principal-refs-and-question-verbs.mdx), [conditions](./apps/docs/content/docs/concepts/conditions.mdx)).
4. Resolved: snapshots ship full grants with normalised conditions; `include` is the size lever ([ADR 0031](./apps/docs/content/docs/decisions/0031-snapshot-contents.mdx)).
5. A protected-query helper (`permdock.protect(queryFn, { before, after })`) for co-located redaction (Kilpi's idea).
6. Whether `collect` should also emit the `mergePermissions` barrel or only the catalog.
7. Field-level API shape — resolved: `fields` on the grant and `permdock.pick` ([0033](apps/docs/content/docs/decisions/0033-field-level-grants.mdx)).
8. Resolved, see below.
9. Resolved: quotas belong in core behind `limits` / `memoryLimitStore()`; `can` never consumes; a thenable or thrown store is `limit-unavailable` ([ADR 0034](./apps/docs/content/docs/decisions/0034-quota-grants.mdx)).
10. Resolved, see below.
11. Which OS keychain binding `permdock/terminal` uses as its optional peer, and whether the mode-0600 file fallback is acceptable in CI images.
12. Resolved: `parent.resource` is a resource name string; a resource has exactly one parent, resolved at `definePolicy` ([ADR 0030](./apps/docs/content/docs/decisions/0030-parent-typing.mdx)).
13. Deferred to Phase 2: `exclusiveWith` ships as a `permdock doctor` lint over memberships, not an evaluation rule ([tenancy](./apps/docs/content/docs/concepts/tenancy.mdx)).
14. Resolved: `snapshot({ tenants: 'all' })` stays opt-in; no membership-count threshold ([ADR 0031](./apps/docs/content/docs/decisions/0031-snapshot-contents.mdx)).
15. `useApproval` transport: poll `approvalsHandler` (default) or subscribe through a `SnapshotSource`.

Resolved: multi-tenant roles, teams, resource roles and tenant-defined custom roles are memberships on the principal plus scoped role declarations, with `RoleSource` and `MembershipSource` as the only new inputs; provider principal types extend through generics and Standard Schema, never module augmentation ([ADR 0024](./apps/docs/content/docs/decisions/0024-scoped-roles-and-memberships.mdx)). Delegation-chain and token verification never happen in core; `permdock/jwt` and the provider `subjectFrom*` helpers verify and hand core a subject ([ADR 0018](./apps/docs/content/docs/decisions/0018-authentication-is-upstream.mdx)). Decision-endpoint auth (8): the in-app endpoint uses the application's session or bearer via `subject`; the hosted ADS accepts Vercel OIDC or client-credentials tokens verified with `permdock/jwt`; no shared-secret mode ([ADR 0021](./apps/docs/content/docs/decisions/0021-embedded-pdp-hosted-ads.mdx)). `approval-required` over HTTP (10): retry with a `PermDock-Approval: <token>` header against an `approved` `ApprovalStore` record ([ADR 0022](./apps/docs/content/docs/decisions/0022-approvals-are-pluggable.mdx)). Sink sampling: every event is written by default, sampling is opt-in; the SCIM receiver is scheduled as `permdock/scim` with a hosted relay ([ADR 0027](./apps/docs/content/docs/decisions/0027-governance-first-cloud.mdx)). Core evaluation is synchronous; closures return a boolean; `explain` is not an alias of `decide` ([ADR 0028](./apps/docs/content/docs/decisions/0028-synchronous-evaluation.mdx)). Collection `check` is optional-body ([ADR 0029](./apps/docs/content/docs/decisions/0029-check-on-collection-actions.mdx)). `parent.resource` is a name string ([ADR 0030](./apps/docs/content/docs/decisions/0030-parent-typing.mdx)). Snapshots ship full grants; `tenants: 'all'` stays opt-in ([ADR 0031](./apps/docs/content/docs/decisions/0031-snapshot-contents.mdx)). Quota grants use `limits` / `memoryLimitStore()`; `can` never consumes ([ADR 0034](./apps/docs/content/docs/decisions/0034-quota-grants.mdx)).

## 14. Commercial model

The library is and stays MIT. PermDock is a policy decision point you embed; PermDock Cloud, in the separate `PermDock-Cloud` repository, is an optional control plane and Authorization Decision Service that never sits on the decision path. It leads with the decision log sold as compliance evidence and agent governance: access-review queries per principal, actor, tenant and window, agent-activity views, the approval chain joined on `token`, signed exports (`permdock-decisions+jwt`), OCSF forwarding and CSV for Vanta, Drata and Secureframe, retention tiers. Behind it: a hosted AuthZEN endpoint for gateways and non-TypeScript services, an approval inbox with delivery (Slack and Teams through the Vercel Chat SDK recipe self-hosters can run themselves) and approver management, a hosted SCIM relay with an IdP wizard, group-to-role mapping UI and sync log that replays provisioning into the application's own `scimHandler`, snapshot distribution with CAEP invalidation, catalog dashboards, and an integrations catalog in which every connector is a standard wire format (JWKS and OIDC Discovery for trusted issuers, CAEP, SCIM, OTLP, OCSF, CloudEvents, JOSE, a read-only MCP server) and never a per-vendor package. Every hosted capability is an interface in the open-source package with an in-process default (`ApprovalStore`, `DecisionSink`, `SnapshotSource`, `DirectoryStore`), so a team can self-host the whole thing over its own database; the Cloud is the managed implementation, the Supabase model.

Meters: monthly active principals (a human and each agent `actor` counted once), connected tenants (a tenant with a SCIM connection or a tenant-scoped inbox), resolved approvals above a free allowance at a small per-unit price, a decision retention tier, and hosted ADS evaluations. Decisions made by the embedded engine are never metered. The inbox is a feature, not the product.

Posture: the realistic upside for an independent authorization company is acquisition by an identity or platform vendor, so PermDock positions for an acquirer rather than a category win. Standards-first wire formats let the Cloud port into an acquirer's stack; distribution is Vercel-native (Marketplace integration, environment per project, env-var provisioning, `eve-agent` as the template); PermDock builds no authentication product and no gateway, so every `subjectFrom*` provider remains a possible acquirer or co-marketer; the Cloud repository stays thin and bound to this repository's interfaces; the MIT core is untouchable. Rationale and market evidence: [ADR 0021](./apps/docs/content/docs/decisions/0021-embedded-pdp-hosted-ads.mdx), [ADR 0027](./apps/docs/content/docs/decisions/0027-governance-first-cloud.mdx), [commercial landscape](./apps/docs/content/docs/research/commercial-landscape.mdx).
