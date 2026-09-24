# PermDock

**Typed permissions for TypeScript apps, APIs, databases, and AI agents.**

[![npm](https://img.shields.io/npm/v/permdock?label=permdock)](https://www.npmjs.com/package/permdock)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](./CODE_OF_CONDUCT.md)
[![CI](https://img.shields.io/github/actions/workflow/status/ScaleDockHQ/PermDock/ci.yml?label=CI)](https://github.com/ScaleDockHQ/PermDock/actions)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9%20%7C%206%20%7C%207-3178c6.svg)

Define permissions once as typed references over the Zod, Valibot or ArkType schemas you already have. Grant them to roles with portable conditions. Check them in React, React Native, Next.js, Hono, tRPC and MCP servers. Compile the same conditions to SQL `where` clauses and Postgres Row Level Security policies. Drive tool approvals in the Vercel AI SDK, the Claude Agent SDK, Eve and the OpenAI Agents SDK from the same decision.

> **Status: Phase 4 in progress.** Phase 1–3 OSS has shipped (core, surface adapters, CLI, data compilers, providers). `permdock`, `@permdock/cli` and `@permdock/testing` are published as `0.1.0`. External AuthZEN certification remains the remaining `1.0` gate. See the [roadmap](./apps/docs/content/docs/roadmap.mdx).

## Why PermDock

Permission logic in a typical TypeScript app is spread across `if (user.role === 'admin')` checks in components, string keys like `'post:update'` in middleware, a hand-written client copy of the server rules, RLS policies nobody can diff against the app, and, increasingly, AI agents that call tools on a user's behalf with no way to say "ask first". PermDock replaces all of that with one definition and one decision object:

- **Reference-based.** `permissions.post.update` is a typed, frozen object carrying `key`, `scope`, schema and metadata. Go-to-definition, rename-safe, no template-literal unions for TypeScript 7 to expand, and the runtime definition *is* the catalog.
- **Standard-Schema-native.** Resources are built from any [Standard Schema](https://standardschema.dev) validator; instance types are inferred; untrusted inputs are validated at trust boundaries only.
- **Policy as data.** Roles are arrays of `allow` / `deny` grants with a portable condition AST. One condition evaluates to a boolean in the browser, filters arrays, compiles to Drizzle / Prisma / Kysely `where`, and generates Postgres RLS.
- **Multi-tenant roles without a second system.** A role is held globally, in a tenant, in a team or on one resource; `role('admin', grants, { on: 'tenant' })` replaces the `orgId` condition you used to repeat on every grant. Tenant admins compose their own roles from the ones you declared, never wider. Memberships come from your auth provider; PermDock stores nothing. Read [Tenants, teams and scoped roles](./apps/docs/content/docs/concepts/tenancy.mdx).
- **Immutable, request-scoped.** `createPermDock(policy, user)` returns a frozen `PermDock`. Safe in RSC, edge, serverless and concurrent requests. `permdock.tenant(id)` derives another frozen instance for a tenant switch or a preview.
- **Decisions, not booleans.** `decide()` returns `granted`, `denied` or `approval-required` with the matched grant, denial reasons and permitted alternatives. Adapters turn that into RFC 9457 Problem Details, model-readable MCP refusals and AI SDK approval states.
- **Snapshots that carry conditions.** The client answers ownership checks offline; no duplicated client rules; `<Protected>` never blocks a Next.js 16.3 instant navigation.
- **Agent-native.** Two-principal subject (principal + actor + delegation), MCP / AI SDK / Claude Agent SDK / Eve / OpenAI Agents SDK / WebMCP / A2A adapters, an AuthZEN 1.0 decision endpoint, shipped skills, `AGENTS.md` and `llms.txt`.
- **Human approvals that resume safely.** `approval: 'human'` grants yield a third outcome with a replay-safe `token`; pending approvals live in a pluggable `ApprovalStore` (in-memory by default, your database, or PermDock Cloud), approvers are authenticated and never the agent, and plain HTTP resumes with a `PermDock-Approval` header.
- **The Cloud is optional.** Every decision runs in-process. PermDock Cloud adds the decision log as compliance evidence and agent governance (access reviews, agent activity, signed and OCSF exports), a hosted AuthZEN Authorization Decision Service, an approval inbox and a SCIM relay into a directory store your app owns (`permdock/scim`), all behind interfaces the open-source package ships with in-process defaults; self-host or subscribe, the library is the same, and the Cloud never decides. Dashboard [app.permdock.com](https://app.permdock.com), API [api.permdock.com](https://api.permdock.com), read-only MCP [mcp.permdock.com](https://mcp.permdock.com). Read [ADR 0021](./apps/docs/content/docs/decisions/0021-embedded-pdp-hosted-ads.mdx) and [ADR 0027](./apps/docs/content/docs/decisions/0027-governance-first-cloud.mdx).
- **RLS round-trip.** `permdock rls generate | import | verify` for Supabase, Neon and generic Postgres.
- **Secure by default.** Fail-closed, deny overrides allow, unknown reference is a type error, prototype-safe, no eval, `service_role` never emitted, model-supplied subjects never trusted, never a default tenant.
- **Authentication stays upstream.** PermDock consumes verified material only: sessions, JWKS-verified JWTs (`permdock/jwt` with OIDC Discovery, `at+jwt` / `typ` checks, the RFC 9864 algorithm allow-list, FAPI 2.0 profile, RFC 9068 `roles` / `groups` claims, `jose` as an optional peer behind a pluggable `TokenVerifier`), Supabase / Clerk / Better Auth claims and memberships, MCP `authInfo`, workload identities. Every `subjectFrom*` mapper takes a Standard Schema for your custom claims; token failures surface as RFC 6750 `WWW-Authenticate` challenges, never as thrown errors. Read [Authentication](./apps/docs/content/docs/concepts/authentication.mdx), [OpenID Connect](./apps/docs/content/docs/standards/openid-connect.mdx) and [JOSE](./apps/docs/content/docs/standards/jose.mdx).
- **Interoperable by construction.** Everything PermDock signs (snapshots, cross-service approval tokens, decision exports) is compact JWS with registered header parameters and claim names, so a Go, Python, Java or .NET service verifies it with any JOSE library and a published JWK Set. Read [Wire formats](./apps/docs/content/docs/concepts/wire-formats.mdx).

## Install

```bash
pnpm add permdock            # core + every adapter as subpath exports
pnpm add -D @permdock/cli    # collect, catalog, usage, openapi, rls, doctor, skills
pnpm add -D @permdock/testing
```

ESM-only. TypeScript 5.9, 6 and 7 are tested. Core has no runtime dependencies other than `@standard-schema/spec`.

## Quick start

### 1. Define permissions (importable everywhere: server, client, React Native, MCP, tests)

```ts
// src/permissions.ts
import { definePermissions, defineRoles, resource } from 'permdock'
import { z } from 'zod' // or valibot / arktype / effect

const Post = z.object({ id: z.string(), authorId: z.string(), orgId: z.string(), published: z.boolean() })

export const permissions = definePermissions({
  post: resource(Post, {
    id: 'id',                                          // identity field: cache keys, filter, RLS
    actions: ['read', 'update', 'delete', 'publish'],  // take an instance
    collection: ['create', 'list'],                    // do not
  }),
  billing: {
    invoice: resource(Invoice, { actions: ['read', 'pay'] }),
    plan: resource({ collection: ['view', 'change'] }), // schema-less
  },
})

permissions.post.update.key                // 'post.update'
permissions.billing.invoice.pay.scope      // 'billing:invoice:pay' (OAuth / MCP scope)
```

```ts
export const roles = defineRoles({
  member: {},
  admin: { on: 'tenant' },
})
```

### 2. Write the policy (server-only; roles are data, conditions are portable)

```ts
// src/policy.ts
import { definePolicy, role, allow, deny, principal, relation } from 'permdock'
import { permissions, roles } from './permissions'

const member = role(roles.member, [
  allow(permissions.post.read),
  allow(permissions.post.list),
  allow(permissions.post.create),
  allow(permissions.post.update, { to: relation(permissions.post, 'author') }),                       // portable
  allow(permissions.post.publish, (post, ctx) => post.authorId === ctx.subject.id),           // closure: server-only
  allow(permissions.post.delete, { where: { authorId: principal.id }, approval: 'human' }),     // → 'approval-required'
])

const admin = role(roles.admin, [...member.grants, allow(permissions.post.delete)], { on: 'tenant' })  // held per tenant

export const policy = definePolicy({ permissions, roles }, {
  roles: [member, admin],
  scopes: { tenant: { key: 'orgId' } },   // the field a tenant-scoped grant compares against the membership
  principal: (user: User | null) => user && { id: user.id, roles: user.roles, tenant: user.activeOrgId, memberships: user.memberships },
  validate: 'boundary', // validate data that crossed a trust boundary, skip trusted server rows
})
```

`memberships` is `[{ tenant: 'o_acme', roles: ['admin'] }, { tenant: 'o_acme', team: 't_design', roles: ['lead'] }]`: a list your auth provider already has. `subjectFromClerk`, `subjectFromBetterAuth`, `subjectFromSupabase` and `subjectFromJwt` produce it for you.

### 3. Create a `PermDock` and decide

```ts
import { createPermDock } from 'permdock'

const permdock = await createPermDock(policy, user)      // frozen, request-scoped, never throws
permdock.can(permissions.post.update, post)              // boolean
permdock.can(permissions.post.create)                    // collection action: arity is in the type
permdock.actions(permissions.post, post)                 // Permission[] this subject may perform on the row
permdock.heldRoles()                                     // Role[]
permdock.decide(permissions.post.delete, post)           // { outcome: 'granted' | 'denied' | 'approval-required', ... }
permdock.assert(permissions.post.delete, post)           // narrows subject or throws PermDockDeniedError
permdock.filter(permissions.post.read, posts)            // Post[]
permdock.where(permissions.post.read)                    // portable condition → Drizzle / Prisma / Kysely / SQL
permdock.snapshot({ include: [permissions.post] })       // JSON for the client
permdock.tenant('o_globex').can(permissions.post.delete, post)  // derived instance with another active tenant
permdock.tenants()                                       // ['o_acme', 'o_globex'] for a tenant switcher
```

### React

```tsx
import { PermDockProvider, usePermission, useTenant, useFilter, Protected } from 'permdock/react'

<PermDockProvider snapshot={snapshot} endpoint="/api/permdock">
  <Protected permission={permissions.post.update} data={post} pending={<Skeleton />} fallback={<Locked />}>
    <EditButton />
  </Protected>
</PermDockProvider>

const { allowed, status } = usePermission(permissions.post.update, post) // 'ready' | 'pending' | 'stale' | 'server-only'
const { tenant, tenants, switchTo } = useTenant()                        // tenant switcher from the same snapshot
const editable = useFilter(permissions.post.update, posts)               // the rows this user may edit
```

Also `usePermissions`, `useMemberships`, `useRoles`, `useAssignableRoles`, `useApproval`, `useSubject` and the pure `describe(decision)` for "why not" tooltips; the same names in React Native, Vue, Svelte and Solid. Read [Building UI](./apps/docs/content/docs/concepts/ui.mdx).

### Next.js 16.3

```ts
// src/permdock/server.ts
import { createPermDock } from 'permdock/next'
export const { getPermDock, getPermission, PermDockProvider, permdockHandler } = createPermDock(policy, {
  subject: async () => getUser(await cookies()),
  tag: (user) => `permdock:${user.id}`,
})

// app/posts/[id]/page.tsx
const permdock = await getPermDock()
permdock.assert(permissions.post.update, post)

// app/api/permdock/route.ts
export const { POST } = permdockHandler()
```

### Hono (same shape for Express, Fastify, Elysia, Nest, Node, tRPC, oRPC)

```ts
import { createPermDock } from 'permdock/hono'
export const { permdock, protect } = createPermDock(policy, { subject: (c) => c.get('user') })

app.use(permdock())
app.delete('/posts/:id', protect(permissions.post.delete, (c) => loadPost(c.req.param('id'))), handler)
// deny → 403 application/problem+json with permission, denials and alternatives
```

### MCP

```ts
import { createPermDock } from 'permdock/mcp'
const { protectServer } = createPermDock(policy, { subject: (authInfo) => userFrom(authInfo) })
const guarded = protectServer(server)
guarded.registerTool('delete_post', { permission: permissions.post.delete, inputSchema, data: (args) => loadPost(args.id) }, handler)
// scopeChallenge step-up, list_tools filtered per caller, args validated, refusals carry reasons + alternatives
```

### AI SDK

```ts
import { createPermDock } from 'permdock/ai-sdk'
const { toolApproval, capabilityMiddleware } = createPermDock(policy, {
  subject: ({ runtimeContext }) => runtimeContext.user,
  actor: ({ runtimeContext }) => ({ id: runtimeContext.agentId, kind: 'ai-sdk' }),
  tools: { delete_post: { permission: permissions.post.delete, data: (args) => loadPost(args.id) } },
})
generateText({ model, tools, toolApproval }) // granted → 'approved', denied → 'denied', approval-required → 'user-approval'
```

### Eve

```ts
import { defineTool } from 'eve/tools'
import { createPermDock } from 'permdock/eve'
import { memoryApprovalStore } from 'permdock/approvals'
const { approval } = createPermDock(policy, {
  tools: { refund: { permission: permissions.charge.refund, data: (input) => loadCharge(input.chargeId) } },
  store: memoryApprovalStore(),   // or drizzleApprovalStore(db), or cloud().approvals
})
export default defineTool({ description: 'Refund a charge.', inputSchema, approval, execute })
// granted → "not-applicable" (run), approval-required → "user-approval" (session parks), denied → { type: "denied", reason }
// approval.response checks the responder against the store: an agent never approves its own call
```

### RLS

```bash
permdock rls generate --target drizzle --dialect supabase   # roles × grants → policies
permdock rls import --db $DATABASE_URL --out src/permissions.generated.ts
permdock rls verify --db $DATABASE_URL                      # can() vs database parity
```

## Larger apps

Define permissions once and import them anywhere, or colocate `definePermissions()` per feature and merge them centrally. Both resolve by `key`, so leaves stay identical across bundles and serialisation boundaries.

```ts
// src/permissions.ts
import { mergePermissions } from 'permdock'
import { postPermissions } from '@/features/posts/permissions'
import { billingPermissions } from '@/features/billing/permissions'
import { generated } from './permissions.generated' // from `permdock rls import` or `permdock openapi import`

export const permissions = mergePermissions(postPermissions, billingPermissions, generated)
```

Role fragments merge by name, `permdock collect` keeps a catalog as a compile output (the next-intl `useExtracted` model) and fails CI on drift, and scoped snapshots send a route only the grants it needs. Read [Larger apps](./apps/docs/content/docs/getting-started/larger-apps.mdx).

## Works with

Any Standard Schema validator: Zod, Valibot, ArkType, Effect Schema. Then, one import path per target (phase in brackets; example app under `apps/examples/`):

| Group | Adapters |
| --- | --- |
| UI | `permdock/react` `react-vite` [1] · `permdock/react-native` `expo` [2] · `permdock/vue` `vue` [2] · `permdock/svelte` `svelte` [2] · `permdock/solid` `solid` [2] |
| Full-stack | `permdock/next` `next` [1] |
| HTTP | `permdock/server` kernel [1] · `permdock/hono` `hono` [1] · `permdock/express` `express` [2] · `permdock/fastify` `fastify` [2] · `permdock/elysia` `elysia` [2] · `permdock/nest` `nest` [2] · `permdock/node` [2] |
| Terminal | `permdock/terminal` `terminal` [2] for your own commander / citty / oclif / yargs / Ink CLI (not `@permdock/cli`) |
| RPC | `permdock/trpc` `trpc` [2] · `permdock/orpc` `orpc` [2] |
| Agents | `permdock/mcp` `mcp-server` [2] · `permdock/ai-sdk` `ai-sdk-agent` [1] · `permdock/claude-agent` `claude-agent` [1] · `permdock/eve` `eve-agent` [1] · `permdock/openai` `openai-agent` [1] · `permdock/webmcp` `webmcp` [2] · `permdock/a2a` `a2a-agent` [2] |
| Decision plane | `permdock/authzen` `authzen-pdp` [2] · `permdock/approvals` (`ApprovalStore`, `approvalsHandler`) [1] · `permdock/cloud` (optional PermDock Cloud client) [2] · `permdock/scim` (`scimHandler`, `DirectoryStore`) [2] · `permdock/ssf` [3] · `permdock/openapi` (3.2 document or Overlay) [2] · `permdock/otel` [2] · `permdock/pdp` [4] |
| Data | `permdock/drizzle` `drizzle` [3] · `permdock/prisma` `prisma` [3] · `permdock/kysely` [3] · `permdock rls` `supabase-rls` [3] |
| Auth and providers | `permdock/jwt` (OIDC Discovery, RFC 9068 roles and groups, `TokenVerifier` / `TokenSigner`) [1] · `permdock/supabase` (tenant and memberships claims) [3] · `permdock/supabase/middleware` `supabase-middleware` (`withPermDock` for the `@supabase/middleware` pipeline; `@supabase/server` and `@supabase/ssr` are recipes) [4] · `permdock/better-auth` `better-auth` (organizations, teams, dynamic roles) [4] · `permdock/clerk` `clerk` (organizations, custom roles) [4] · `permdock/convex` `convex` [4] |
| Testing | `@permdock/testing` [1] |

Full matrix with status, phases and related standards: [Adapters](./apps/docs/content/docs/adapters/index.mdx).

Nuxt, Astro, React Router, TanStack Start and Effect stay on the shipped adapters plus `@permdock/cli/unplugin` ([unplugin recipes](./apps/docs/content/docs/cli/unplugin.mdx)); there is no `permdock/nuxt` or other per-vendor package ([0023](./apps/docs/content/docs/decisions/0023-compose-openapi-ecosystem.mdx)).

Around the OpenAPI output, PermDock composes with the tools you already run rather than wrapping them: next-openapi-gen (Next.js, TanStack Start, React Router, SvelteKit, Nuxt, Astro), Redocly CLI, Bump.sh and Speakeasy apply the Overlay; Hey API, Orval, Kubb, Scalar, Mintlify, Fern and OpenAPI-to-MCP bridges read the result as standard `security`; Schemathesis and oasdiff turn it into CI checks. The same rule covers MCP hosting (`mcp-handler`), approval delivery (Vercel Chat SDK to Slack and Teams), identity providers and observability sinks. Recipes on the [OpenAPI adapter](./apps/docs/content/docs/adapters/openapi.mdx) and [approvals](./apps/docs/content/docs/adapters/approvals.mdx) pages; every named tool in the [ecosystem index](./apps/docs/content/docs/research/ecosystem-index.mdx); the rule in [decision 0023](./apps/docs/content/docs/decisions/0023-compose-openapi-ecosystem.mdx).

## Comparison

- **permix**: closest in adapter breadth, but a mutable global core, boolean-only hydration and no explain.
- **CASL v7**: mature conditions → Prisma / Mongoose `where` and field rules; declared string tuples, no Standard Schema, no SSR / RN / MCP / OpenAPI story.
- **Kilpi v1**: server-first async policies, `Grant` / `Deny`, RSC `<Access>`; zod + superjson in core, no Standard Schema, RN, MCP or OpenAPI.
- **`@zap-studio/permit`**: the only other Standard-Schema authz library; boolean results, sync-only rules, no adapters, hydration, OpenAPI or MCP.
- **Better Auth access control**: RBAC statements bound to Better Auth; PermDock layers conditions, snapshots and adapters on top via a provider.
- **Auth-provider RBAC (Clerk, Auth0, WorkOS, Kinde, Frontegg, Descope)**: organization roles and sometimes custom roles, checked as booleans inside the provider's SDK; PermDock reads their memberships as the subject and adds scoped roles, row conditions, approvals and the data compilers. Survey: [SaaS tenancy and roles](./apps/docs/content/docs/research/saas-tenancy-and-roles.mdx).
- **Hosted PDPs (Cerbos, Permit.io, OpenFGA, SpiceDB, Oso Cloud)**: strings in, boolean out over the network; PermDock embeds as a typed library, can act as an AuthZEN PDP or PEP to them, and offers the operational layer they sell (approvals, decision log, hosted AuthZEN ADS) as an optional Cloud that is never on the decision path.
- **ZenStack v3**: compiles policies to SQL but dropped the database-free `check()`; PermDock keeps in-process, UI and SQL evaluation on one AST.
- **`@ai-sdk/policy-opa`**: Rego policies for AI SDK tool approvals that fail open on unrecognised decisions; `permdock/ai-sdk` uses the app's own typed policy and fails closed.
- **Cedar / AWS Verified Permissions, OPA / Rego, Casbin**: general policy engines with their own languages; PermDock keeps policies as TypeScript data and can sit in front of them as an AuthZEN PEP (`permdock/pdp`).
- **Zanzibar family (OpenFGA, SpiceDB, Auth0 FGA, WorkOS FGA)**: relationship graphs at scale; PermDock does not replace them and bridges to them through a provider when a relation lookup is needed.

Details and a feature matrix: [Comparison](./apps/docs/content/docs/comparison.mdx).

## For AI agents

```bash
npx skills add ScaleDockHQ/PermDock   # installs the `wire-permdock` and `audit-permissions` skills
```

- [`AGENTS.md`](./AGENTS.md) (`CLAUDE.md` imports it) describes the repo, invariants and update rules.
- Every docs page is served as `.md`, plus `llms.txt` and `llms-full.txt`. The public docs MCP is `POST /mcp` (`search_docs`, `get_page`; no subject). The Cloud MCP is [mcp.permdock.com](https://mcp.permdock.com) (read-only evidence and catalog; never resolves an approval). The decide explorer is `/devtools`.
- Denials are written for models: every `denied` decision carries reasons and permitted `alternatives`; every `approval-required` decision carries a replay-safe `token`.
- `permdock doctor` and `permdock collect --check` give deterministic feedback in CI.

Read [For AI agents](./apps/docs/content/docs/for-ai-agents.mdx).

## Documentation

The marketing site is `apps/marketing` at `/`. Run `pnpm marketing:dev` for the marketing origin on `:3000` with `/docs` proxied to the docs app on `:3001`. Docs alone: `pnpm docs:dev` and open `/docs`. The source of truth is still the MDX tree at [`apps/docs/content/docs`](./apps/docs/content/docs): [getting started](./apps/docs/content/docs/getting-started), [concepts](./apps/docs/content/docs/concepts), [adapters](./apps/docs/content/docs/adapters), [CLI](./apps/docs/content/docs/cli), [standards](./apps/docs/content/docs/standards), [security](./apps/docs/content/docs/security), [research](./apps/docs/content/docs/research) and [decision records](./apps/docs/content/docs/decisions).

The product vision, roadmap and open questions live in [`PRODUCT.md`](./PRODUCT.md).

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). Public API changes go through a short RFC in an issue before a PR. Every adapter ships with a docs page, a skill reference, an example app and tests; the checklist is in [`AGENTS.md`](./AGENTS.md). This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md).

## Security

Report vulnerabilities privately. See [`SECURITY.md`](./SECURITY.md). Do not open public issues for security reports.

## License

[MIT](./LICENSE) © 2026 ScaleDockHQ
