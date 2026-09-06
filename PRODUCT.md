# PermDock — Product

This document is the product overview: what PermDock is, who it is for, what it must do, how it is built and in what order. Detail lives in the documentation tree under [`apps/docs/content/docs`](./apps/docs/content/docs) (Fumadocs-ready MDX) and is linked from each section. When the two disagree, the docs tree wins and this file gets fixed.

Version: Phase 0 (September 2026). Nothing is published yet.

## 1. Vision and positioning

**Tagline.** Typed permissions for TypeScript apps, APIs, databases, and AI agents.

**One-liner.** Define permissions once as typed references over the Zod / Valibot / ArkType schemas you already have; grant them to roles with portable conditions; check them in React, React Native, Next.js, Hono, tRPC and MCP servers; compile the same conditions to SQL `where` clauses and Postgres RLS policies; drive tool approvals in the Vercel AI SDK and Claude Agent SDK from the same decision.

**Why now.** Three things changed in 2025–2026: TypeScript 7 made template-literal-union permission keys expensive and brittle; Next.js 16.3 Instant Navigations made blocking permission checks a visible UX regression; and AI agents started calling tools on users' behalf, with the MCP authorization spec, AuthZEN 1.0, OAuth agent-delegation drafts, Shared Signals / CAEP and the OWASP Agentic Top 10 all landing within twelve months. No TypeScript permissions library was designed for any of the three. PermDock is.

**Origin.** PermDock is the clean-room successor to a 25-PR stack against permix that the maintainer closed as "changes the public API" ([permix lessons](./apps/docs/content/docs/research/permix-lessons.mdx)). It copies none of permix's, CASL's or Kilpi's naming or API surface ([landscape](./apps/docs/content/docs/research/landscape.mdx)).

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
| Standards-first | AuthZEN, OpenAPI 3.2, Standard Schema, RFC 9457, RFC 9396, SSF/CAEP, MCP, WebMCP, A2A | [standards](./apps/docs/content/docs/standards/index.mdx) |
| Delegation-aware | Subject = principal + actor + delegation; an agent never exceeds its user | [subject](./apps/docs/content/docs/concepts/subject.mdx), [ADR 0012](./apps/docs/content/docs/decisions/0012-two-principal-subject.mdx) |
| Agent-readable | Skills, `AGENTS.md`, `llms.txt`, JSON Schema catalog, model-readable denials | [agent docs standards](./apps/docs/content/docs/standards/agent-docs-standards.mdx) |
| Small | ESM-only, zero runtime deps in core, under ~3 kB gzip | [ADR 0015](./apps/docs/content/docs/decisions/0015-no-runtime-deps-in-core.mdx) |

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
10. **OpenAPI 3.2 in and out.** Emit `securitySchemes`, per-operation `security`, `x-permdock-permissions`, with `x-oai-*` fallbacks for 3.1; hooks for hono-openapi, `@hono/zod-openapi`, oRPC, trpc-to-openapi; import a doc into a catalog.
11. **RLS round-trip.** `permdock rls generate | import | verify` for Supabase, Neon and generic Postgres; Drizzle `pgPolicy`, raw SQL and Prisma 8 targets; parity tests.
12. **Universal Fetch-first server kernel** → thin, typed adapters for Hono, Express, Fastify, Elysia, Nest, Node, tRPC, oRPC.
13. **Bring-your-own-auth providers.** Supabase, Better Auth, Clerk, Convex, HTTP PDP.
14. **Agent-native.** Skills (`wire-permdock`, `audit-permissions`) in the package and on skills.sh, `AGENTS.md` with `CLAUDE.md` symlink, `llms.txt` and `.md` per docs page, docs MCP server, JSON Schema catalog, `permdock doctor`, deterministic codegen, docs written as MDX from day one.
15. **Modern toolchain.** ESM-only, zero runtime deps in core, TS 5.9/6/7 with `isolatedDeclarations` and `erasableSyntaxOnly`, core under ~3 kB gzip, Oxlint / Oxfmt, Vitest type tests, `publint` + `arethetypeswrong`.
16. **Secure defaults.** Fail-closed, deny overrides allow, unknown reference = type error, prototype-safe, no eval, `service_role` never emitted, model-supplied subjects never trusted.
17. **Agent-runtime approvals.** One `Decision` drives AI SDK 7 `toolApproval` / capability middleware / `WorkflowAgent` `needsApproval`, Claude Agent SDK `canUseTool`, and MCP elicitation; `approval: 'human'` grants, replay-safe `token`, `alternatives` for self-correction, `simulate()` pre-flight for plans.
18. **Delegation-aware.** Principal + actor + delegation subject; RFC 9396 `authorization_details` per permission; works behind MCP Enterprise-Managed Authorization and agent delegation chains.
19. **Standards-native decision plane.** AuthZEN 1.0 endpoint and PEP client (certification target), SSF/CAEP receiver for continuous evaluation, OpenAPI 3.2 security output, A2A Agent Card security, WebMCP tool gating; OWASP Agentic Top 10 (ASI02 / ASI03) mapped to concrete mitigations.

### Competitor summary

| Library | Strength | Gap PermDock fills | Research |
| --- | --- | --- | --- |
| CASL v7 | Conditions → Prisma / Mongoose `where`, field rules, ~1.4M weekly downloads | String tuples, no Standard Schema, no SSR / RN / MCP / OpenAPI | [casl-v7](./apps/docs/content/docs/research/casl-v7.mdx) |
| permix v4 | Adapter breadth | Mutable global core, boolean hydration, no explain, closed to API change | [permix-lessons](./apps/docs/content/docs/research/permix-lessons.mdx) |
| Kilpi v1 | Server-first async policies, `Grant` / `Deny`, RSC `<Access>` | zod + superjson in core, no Standard Schema / RN / MCP / OpenAPI, single maintainer | [kilpi-v1](./apps/docs/content/docs/research/kilpi-v1.mdx) |
| `@zap-studio/permit` v2 | Standard Schema resources, ~2.8 kB, fail-closed | Boolean-only, sync-only rules, no adapters | [zap-studio-permit](./apps/docs/content/docs/research/zap-studio-permit.mdx) |
| Better Auth AC | RBAC bound to Better Auth sessions | No conditions / snapshots / adapters; PermDock layers on top | [landscape](./apps/docs/content/docs/research/landscape.mdx) |
| Cerbos, Permit.io, OpenFGA, SpiceDB, Oso Cloud | Hosted PDPs, policy languages, relation graphs | Strings in, boolean out; not embeddable as a typed TS library; PermDock bridges via AuthZEN / `pdp` | [landscape](./apps/docs/content/docs/research/landscape.mdx) |
| ZenStack v3 | Policies compiled to SQL | Dropped DB-free `check()` | [landscape](./apps/docs/content/docs/research/landscape.mdx) |
| `@ai-sdk/policy-opa` | Reference AI SDK policy adapter | Rego, fails open on unrecognised decisions | [agent-standards-2026](./apps/docs/content/docs/research/agent-standards-2026.mdx) |

Full matrix: [comparison](./apps/docs/content/docs/comparison.mdx).

## 5. Feature scope

**Must (v0.1, Phase 1)**

- `definePermissions` / `resource` / nested groups / `id` field / action metadata; `mergePermissions`, `listPermissions`, `findPermission`.
- `definePolicy` / `role` / `allow` / `deny` / `subject` / `context` / `validate`; role fragments merged by name; `approval: 'human'`.
- Portable condition AST with in-memory evaluator; closures as branded non-portable grants.
- Two-principal subject (`principal`, `actor`, `delegation`).
- `createPermDock` with `can`, `decide` (three outcomes), `assert`, `filter`, `simulate`, `snapshot`, `on`.
- Standard Schema validation in `boundary` mode; `PermDockValidationError`.
- AuthZEN-shaped decision endpoint and batched client.
- `permdock/react`, `permdock/next` (Cache Components, explicit factory), Fetch kernel + `permdock/hono`, `permdock/ai-sdk`, `permdock/claude-agent`, `@permdock/testing`.
- Skills, `AGENTS.md`, `llms.txt`; `apps/docs` scaffolded over the Phase 0 content; examples `next`, `react-vite`, `hono`, `ai-sdk-agent`, `claude-agent`; `tests/types` TS matrix.

**Should (v0.2–0.9, Phases 2–3)**

- `permdock/mcp` (scopeChallenge, EMA, elicitation), `permdock/authzen` full endpoint set + certification run, `permdock/openapi` (3.2), `permdock/react-native`, Express / Fastify / Elysia / Nest / Node, tRPC / oRPC, Vue / Svelte / Solid, `permdock/webmcp`, `permdock/a2a`, `permdock/otel`.
- CLI `collect` (+ `createPermDockPlugin` build hook), `catalog`, `usage`, `doctor`; example per adapter plus `monorepo`; `tests/e2e`.
- `permdock.where` compilers for Drizzle, Prisma, Kysely; `permdock rls generate | import | verify`; `permdock/supabase`; async `context`; schema-aware field-level grants; `permdock/ssf`; `tests/integration` parity suite; examples `supabase-rls`, `drizzle`, `prisma`.

**Later (v1.0, Phase 4)**

- `permdock/better-auth`, `permdock/clerk`, `permdock/convex`, `permdock/pdp` (AuthZEN client); quota grants with pluggable `LimitStore`; Web Bot Auth verification; delegation-chain verification; Nuxt, Astro, React Router, TanStack Start; Effect; docs MCP server; devtools panel.

**Non-goals**

- A hosted policy service, a policy DSL, replacing authentication, issuing tokens, or Zanzibar-scale relation graphs (bridge to OpenFGA / SpiceDB via a provider).

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
| tRPC / oRPC | `permdock/trpc` `permdock/orpc` | `trpc` `orpc` | 2 |
| MCP | `permdock/mcp` | `mcp-server` | 2 |
| AI SDK | `permdock/ai-sdk` | `ai-sdk-agent` | 1 |
| Claude Agent SDK | `permdock/claude-agent` | `claude-agent` | 1 |
| WebMCP | `permdock/webmcp` | `webmcp` | 2 |
| A2A | `permdock/a2a` | `a2a-agent` | 2 |
| AuthZEN | `permdock/authzen` | `authzen-pdp` | 2 |
| SSF / CAEP | `permdock/ssf` | — | 3 |
| OpenAPI 3.2 | `permdock/openapi` | (via `hono`, `orpc`, `trpc`) | 2 |
| OpenTelemetry | `permdock/otel` | — | 2 |
| Drizzle / Prisma / Kysely | `permdock/drizzle` `permdock/prisma` `permdock/kysely` | `drizzle` `prisma` | 3 |
| RLS | `permdock rls` (CLI) | `supabase-rls` | 3 |
| Supabase | `permdock/supabase` | `supabase-rls` | 3 |
| Better Auth / Clerk / Convex | `permdock/better-auth` `permdock/clerk` `permdock/convex` | `better-auth` `clerk` `convex` | 4 |
| PDP client | `permdock/pdp` | — | 4 |
| Testing | `@permdock/testing` | — | 1 |
| Monorepo pattern | `mergePermissions` + `permdock collect --check` | `monorepo` | 2 |

**Shared kernel contract.** Every server adapter wraps `permdock/server`: resolve the subject from the framework's request object, `createPermDock` once per request, expose `protect(permission, loadData)`, validate boundary data against the resource schema, and turn `denied` into a 403 `application/problem+json` body and `approval-required` into a 403 with the `.../approval-required` type. Details: [server kernel](./apps/docs/content/docs/adapters/server-kernel.mdx), [adapter matrix](./apps/docs/content/docs/adapters/index.mdx).

## 7. Standards alignment

| Standard | Use | Page |
| --- | --- | --- |
| Standard Schema v1 + Standard JSON Schema | Resource definitions, inference, boundary validation, catalog | [standard-schema](./apps/docs/content/docs/standards/standard-schema.mdx) |
| OpenAPI 3.2 | Security output and import, `x-oai-*` fallbacks | [openapi-3-2](./apps/docs/content/docs/standards/openapi-3-2.mdx) |
| MCP authorization 2026-07-28 | scopeChallenge, CIMD, RFC 9207, EMA / ID-JAG, elicitation | [mcp-authorization](./apps/docs/content/docs/standards/mcp-authorization.mdx) |
| OpenID AuthZEN 1.0 | Decision endpoint wire format, PEP client, certification | [authzen](./apps/docs/content/docs/standards/authzen.mdx) |
| RFC 9396, RFC 8693, DPoP, agent delegation drafts | Delegation model, `authorization_details` | [oauth-agent-delegation](./apps/docs/content/docs/standards/oauth-agent-delegation.mdx) |
| SSF 1.0 / CAEP 1.0 | Real-time snapshot invalidation | [shared-signals-caep](./apps/docs/content/docs/standards/shared-signals-caep.mdx) |
| RFC 9457 Problem Details | HTTP denial bodies | [problem-details](./apps/docs/content/docs/standards/problem-details.mdx) |
| Postgres RLS | Generate / import / verify | [postgres-rls](./apps/docs/content/docs/standards/postgres-rls.mdx) |
| WebMCP, A2A 1.0, Web Bot Auth | Browser agents, agent cards, agent identity | [webmcp](./apps/docs/content/docs/standards/webmcp.mdx), [a2a](./apps/docs/content/docs/standards/a2a.mdx), [web-bot-auth](./apps/docs/content/docs/standards/web-bot-auth.mdx) |
| AGENTS.md, Agent Skills, llms.txt | Agent-facing docs | [agent-docs-standards](./apps/docs/content/docs/standards/agent-docs-standards.mdx) |

**RLS strategy.** A small portable condition subset round-trips between the app and Postgres (`eq(row.user_id, subject.id)` ↔ `(select auth.uid()) = user_id`); everything else becomes `opaque({ sql, fingerprint })`. Semantics mirror Postgres exactly (read → `SELECT USING`, create → `INSERT WITH CHECK`, update → `USING` + `WITH CHECK`, delete → `DELETE USING`; allow → PERMISSIVE, deny → RESTRICTIVE). Parity is verified per role in a real database. Details: [RLS adapter](./apps/docs/content/docs/adapters/rls.mdx), [RLS research](./apps/docs/content/docs/research/postgres-rls.mdx).

**Next.js 16.3 strategy.** The snapshot resolves from `"use cache: private"` so guards answer from the prefetched App Shell; anything data-dependent streams under Suspense; `updateTag` refreshes prefetches on role change; the example app proves with `@next/playwright` `instant()` that guards never block navigation. Details: [next adapter](./apps/docs/content/docs/adapters/next.mdx), [research](./apps/docs/content/docs/research/nextjs-16-3-instant-navigation.mdx).

**AI-agent strategy.** One `Decision` type is translated into each runtime's approval vocabulary; never `not-applicable`; `approval-required` becomes AI SDK `user-approval`, `WorkflowAgent` `needsApproval`, MCP elicitation or an HTTP 403; `simulate()` pre-flights an agent's plan; denials carry `alternatives`; OWASP ASI02 / ASI03 mitigations are documented feature by feature. Details: [ai-sdk](./apps/docs/content/docs/adapters/ai-sdk.mdx), [claude-agent](./apps/docs/content/docs/adapters/claude-agent.mdx), [approvals](./apps/docs/content/docs/security/approvals.mdx), [owasp-agentic](./apps/docs/content/docs/security/owasp-agentic.mdx).

## 8. Engineering standards

- **Packages.** `permdock` (umbrella, subpath exports, zero runtime deps except `@standard-schema/spec`), `@permdock/cli` (`oxc-parser`, `pgsql-parser`), `@permdock/testing`.
- **Language.** TypeScript 5.9 / 6 / 7 in CI; `isolatedDeclarations`, `erasableSyntaxOnly`, `exactOptionalPropertyTypes`; ESM-only; no JSX in shipped `.mjs` (compiled).
- **Build and lint.** tsdown, Oxlint, Oxfmt; `publint` and `arethetypeswrong` on every package.
- **Tests.** Vitest unit + type tests (95% coverage on core), Playwright e2e across examples (including `instant()`), testcontainers Postgres for RLS parity and providers, per-entry bundle budgets (`tests/bundle`, core under ~3 kB gzip).
- **Repo.** pnpm workspaces + catalogs, Turborepo; `/packages`, `/apps` (docs + examples), `/tests`.
- **Releases.** Changesets (or Release Please) with conventional commits; every adapter entry has its own changelog section.
- **Security.** Fail-closed by construction; prototype-safe paths; no `eval` / `new Function`; server-only entries marked and tested against client bundling; `service_role` never emitted; decision endpoint behind real auth. See [threat model](./apps/docs/content/docs/security/threat-model.mdx).

Full ADR: [0016 repo layout and toolchain](./apps/docs/content/docs/decisions/0016-repo-layout-and-toolchain.mdx).

## 9. Governance

- **RFC-lite for public API changes.** Any change to exported identifiers, wire formats (permission leaf, condition, snapshot, AuthZEN mapping, Problem Details) or CLI flags starts as an issue using the RFC template (context, proposal, alternatives, migration) and is recorded as an ADR under `decisions/` when accepted.
- **Adapter contribution template.** An adapter PR ships the entry, its docs page (`adapters/<name>.mdx` with `Status` / `Phase`), a skill reference update, an example app under `apps/examples/<name>`, tests and a bundle budget. See [`AGENTS.md`](./AGENTS.md).
- **Response-time targets.** Triage issues within 3 business days; security reports acknowledged within 48 hours; API RFCs decided within 2 weeks.
- **Decision log.** `apps/docs/content/docs/decisions/` is append-only; superseded ADRs are marked, not deleted.

## 10. Roadmap

| Phase | Version | Theme | Contents |
| --- | --- | --- | --- |
| 0 | — | Plan and docs | README, PRODUCT, AGENTS, MIT LICENSE, full MDX docs tree (concepts, adapters, standards, security, research, decisions) |
| 1 | v0.1 | Core + agents | Definitions, policies, portable conditions, two-principal subject, `createPermDock`, boundary validation, AuthZEN-shaped endpoint, `react`, `next`, kernel + `hono`, `ai-sdk`, `claude-agent`, `@permdock/testing`, skills, `apps/docs` scaffold, five examples, TS matrix |
| 2 | v0.2–0.5 | Surfaces | `mcp`, `authzen` (+ certification), `openapi`, `react-native`, remaining HTTP / RPC / UI adapters, `webmcp`, `a2a`, `otel`, CLI `collect` / `catalog` / `usage` / `doctor`, example per adapter + `monorepo`, e2e |
| 3 | v0.6–0.9 | Data | `where` compilers, `permdock rls`, `supabase`, async `context`, field-level grants, `ssf`, integration parity suite, data examples |
| 4 | v1.0 | Ecosystem | `better-auth`, `clerk`, `convex`, `pdp`, quotas, Web Bot Auth, delegation-chain verification, more frameworks, docs MCP server, devtools |

Detail: [roadmap](./apps/docs/content/docs/roadmap.mdx).

## 11. Versioning

- `0.x`: minor versions may change public API only through the RFC-lite process with a migration note; patch versions never do.
- `1.0`: when Phase 4 lands and AuthZEN certification is achieved; from then on semver strictly, wire formats versioned separately (`snapshot v1`, catalog `$schema` URL).
- Subpath entries share the package version; an adapter marked `experimental` in its docs page may change in minors.
- TypeScript support window: current stable and the two previous majors that the matrix covers (5.9, 6, 7 today).

## 12. Success metrics

- Adoption: npm downloads, GitHub stars, example-app forks; at least one production case study per adapter group by v1.0.
- Agent time-to-first-check: a coding agent with the `wire-permdock` skill gets a passing `permdock doctor` in a fresh Next.js app in under 10 minutes.
- Bundle: core under 3 kB gzip; each adapter under its budget; budgets enforced in CI.
- Quality: 95% coverage on core; zero open P0 security issues; TS 5.9 / 6 / 7 green.
- Issue SLAs: triage 3 business days, security acknowledgement 48 hours.
- Interop: AuthZEN certification (Basic, Batch, Search, Discovery) by the end of Phase 2.

## 13. Open questions

Tracked in [roadmap](./apps/docs/content/docs/roadmap.mdx); resolved items become ADRs.

1. `decide` vs an `explain` alias for discoverability.
2. `<Protected>` vs a second `<Can>`-style inline render-prop component.
3. `subject.*` reference ergonomics vs closures for common conditions.
4. Whether `snapshot` ships full grants or per-permission booleans for very large policies.
5. A protected-query helper (`permdock.protect(queryFn, { before, after })`) for co-located redaction (Kilpi's idea).
6. Whether `collect` should also emit the `mergePermissions` barrel or only the catalog.
7. Field-level API shape (schema-aware `permittedFields`).
8. Decision-endpoint auth: must be real auth, never Kilpi-style public-secret obfuscation; exact recommended pattern per adapter.
9. `LimitStore` interface and whether quotas belong in core or a subpath.
10. How `approval-required` should surface over plain HTTP beyond a 403 Problem Details type.
11. Whether to verify delegation chains in core or leave it to the token layer.
