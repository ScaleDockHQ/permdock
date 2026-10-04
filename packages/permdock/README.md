# permdock

**Typed permissions for TypeScript apps, APIs, databases and AI agents.**

[![npm](https://img.shields.io/npm/v/permdock?label=permdock)](https://www.npmjs.com/package/permdock)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/ScaleDockHQ/permdock/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/ScaleDockHQ/permdock/ci.yml?label=CI)](https://github.com/ScaleDockHQ/permdock/actions)
![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-5fa04e.svg)
![TypeScript 7](https://img.shields.io/badge/TypeScript-7-3178c6.svg)

Define permissions once as typed references over the Zod, Valibot or ArkType schemas you already have. Grant them to roles with portable conditions. Check them in React, React Native, Next.js, Hono, tRPC and MCP servers. Compile the same conditions to SQL `where` clauses and Postgres Row Level Security policies. Drive tool approvals in the Vercel AI SDK, the Claude Agent SDK, Eve and the OpenAI Agents SDK from the same decision.

> **Pre-release.** The first published version is `0.1.0`. See the [roadmap](https://permdock.com/docs/roadmap).

[Docs](https://permdock.com/docs) · [Quick start](https://permdock.com/docs/getting-started/quick-start) · [Adapters](https://permdock.com/docs/adapters) · [For AI agents](https://permdock.com/docs/for-ai-agents) · [Source](https://github.com/ScaleDockHQ/permdock)

## Install

```bash
pnpm add permdock   # core, every adapter as a subpath export, the permdock CLI and permdock/testing
```

- One package. Core is `permdock`; every adapter is a subpath (`permdock/react`, `permdock/hono`, `permdock/next`, `permdock/ai-sdk`, …). The `permdock` binary (`collect`, `catalog`, `usage`, `openapi`, `rls`, `doctor`, `skills`) and the `permdock/testing` runners ship in the same package.
- ESM only. Node.js 24 or later. Written in and tested with TypeScript 7; the public types are also checked under TypeScript 5.9 and 6.
- Runtime entries depend on `@standard-schema/spec` only. The CLI's dependencies (`oxc-parser`, `citty`, `jiti`, `smol-toml`, `package-manager-detector`, `@clack/prompts`, `diff`) never reach them. Framework SDKs are optional peers, and structurally typed providers (`supabase`, `clerk`, `better-auth`, `convex`, `prisma`, `mcp`, `react-native`) declare no peer at all.

## Why PermDock

Permission logic in a typical TypeScript app is spread across `if (user.role === 'admin')` checks in components, string keys like `'post:update'` in middleware, a hand-written client copy of the server rules, RLS policies nobody can diff against the app, and AI agents that call tools on a user's behalf with no way to say "ask first". PermDock replaces all of that with one definition and one decision object.

- **Reference-based.** `permissions.post.update` is a typed, frozen object carrying `key`, `scope`, schema and metadata. Go-to-definition works, renames are safe, and the runtime definition is the catalog.
- **Standard Schema native.** Resources are built from any [Standard Schema](https://standardschema.dev) validator; instance types are inferred; untrusted input is validated at trust boundaries only.
- **Policy as data.** Roles are arrays of `allow` / `deny` grants with a portable condition AST. One condition evaluates in the browser, filters arrays, compiles to Drizzle / Prisma / Kysely `where`, and generates Postgres RLS.
- **Multi-tenant roles.** A role is held globally, in a tenant, in a team or on one resource: `role('admin', grants, { on: 'tenant' })` replaces the `orgId` condition you used to repeat on every grant. Memberships come from your auth provider; PermDock stores nothing. Read [tenants, teams and scoped roles](https://permdock.com/docs/concepts/tenancy).
- **Decisions, not booleans.** `decide()` returns `granted`, `denied` or `approval-required` with the matched grant, denial reasons and permitted alternatives. Adapters turn that into RFC 9457 Problem Details, model-readable MCP refusals and AI SDK approval states.
- **Snapshots that carry conditions.** The client answers ownership checks offline with no duplicated rules, and `<Protected>` never blocks a Next.js 16.3 instant navigation.
- **Agent-native.** A two-principal subject (principal, actor, delegation), adapters for MCP, the AI SDK, the Claude Agent SDK, Eve, the OpenAI Agents SDK, WebMCP and A2A, an AuthZEN 1.0 decision endpoint, and bundled agent skills.
- **Human approvals that resume safely.** `approval: 'human'` grants yield a third outcome with a replay-safe `token`. Pending approvals live in a pluggable `ApprovalStore`; approvers are authenticated and never the agent; plain HTTP resumes with a `PermDock-Approval` header.
- **Secure by default.** Fail-closed, deny overrides allow, an unknown reference is a type error, prototype-safe, no eval, `service_role` never emitted, model-supplied subjects never trusted, an agent with no delegation denied, no one approving their own request, never a default tenant, data validated against the resource schema unless the caller marks a row it loaded `trusted: true`.
- **Authentication stays upstream.** PermDock consumes verified material only: sessions, JWKS-verified JWTs (`permdock/jwt`, with `jose` as an optional peer), Supabase, Clerk and Better Auth claims, MCP `authInfo`. Token failures become RFC 6750 challenges, never thrown errors. Read [authentication](https://permdock.com/docs/concepts/authentication).
- **The Cloud is optional.** Every decision runs in-process. PermDock Cloud adds a decision log, access reviews, an approval inbox, a hosted AuthZEN endpoint and a SCIM relay, all behind interfaces this package ships with in-process defaults. Read [PermDock Cloud](https://permdock.com/docs/adapters/cloud).

## Quick start

### 1. Define permissions

Importable everywhere: server, client, React Native, MCP, tests.

```ts
// src/permissions.ts
import { definePermissions, defineRoles, resource } from "permdock";
import { z } from "zod"; // or valibot / arktype / effect

const Post = z.object({
  id: z.string(),
  authorId: z.string(),
  orgId: z.string(),
  published: z.boolean(),
});

export const permissions = definePermissions({
  post: resource(Post, {
    id: "id", // identity field: cache keys, filter, RLS
    actions: ["read", "update", "delete", "publish"], // take an instance
    collection: ["create", "list"], // do not
  }),
});

export const roles = defineRoles({ member: {}, admin: { on: "tenant" } });

permissions.post.update.key; // 'post.update'
```

### 2. Write the policy

Server-only. Roles are data; conditions are portable.

```ts
// src/policy.ts
import { allow, definePolicy, principal, relation, role } from "permdock";
import { permissions, roles } from "./permissions";

const member = role(roles.member, [
  allow(permissions.post.read),
  allow(permissions.post.create),
  allow(permissions.post.update, { to: relation(permissions.post, "author") }),
  allow(permissions.post.delete, {
    where: { authorId: principal.id },
    approval: "human",
  }),
]);

const admin = role(
  roles.admin,
  [...member.grants, allow(permissions.post.delete)],
  { on: "tenant" },
);

export const policy = definePolicy(
  { permissions, roles },
  {
    roles: [member, admin],
    scopes: { tenant: { key: "orgId" } },
    principal: (user: User | null) =>
      user && {
        id: user.id,
        roles: user.roles,
        tenant: user.activeOrgId,
        memberships: user.memberships,
      },
    validate: "boundary",
  },
);
```

`subjectFromClerk`, `subjectFromBetterAuth`, `subjectFromSupabase` and `subjectFromJwt` produce `memberships` from the provider you already use.

### 3. Decide

```ts
import { createPermDock } from "permdock";

const permdock = await createPermDock(policy, user); // frozen, request-scoped, never throws
permdock.can(permissions.post.update, post); // boolean
permdock.decide(permissions.post.delete, post); // { outcome: 'granted' | 'denied' | 'approval-required', ... }
permdock.filter(permissions.post.read, posts); // Post[]
permdock.where(permissions.post.read); // portable condition for Drizzle / Prisma / Kysely / SQL
permdock.snapshot({ include: [permissions.post] }); // JSON for the client
```

### React

```tsx
import { PermDockProvider, Protected, usePermission } from "permdock/react";

<PermDockProvider snapshot={snapshot} endpoint="/api/permdock">
  <Protected
    permission={permissions.post.update}
    data={post}
    fallback={<Locked />}
  >
    <EditButton />
  </Protected>
</PermDockProvider>;

const { allowed, status } = usePermission(permissions.post.update, post);
```

The same hook names exist in React Native, Vue, Svelte and Solid. Read [building UI](https://permdock.com/docs/concepts/ui).

### Next.js 16.3

```ts
// src/permdock/server.ts
import { createPermDock } from "permdock/next";

export const { getPermDock, requireAccess, permdockHandler } = createPermDock(
  policy,
  {
    subject: async () => getUser(await cookies()),
  },
);

// in a page or Server Action
await requireAccess({ permission: permissions.post.update, data: post }); // forbidden() / unauthorized() on a denial
```

### Hono

Express, Fastify, Elysia, Nest, Node, tRPC and oRPC have the same shape.

```ts
import { createPermDock } from "permdock/hono";

export const { permdock, protect } = createPermDock(policy, {
  subject: (c) => c.get("user"),
});
app.use(permdock());
app.delete(
  "/posts/:id",
  protect(permissions.post.delete, (c) => loadPost(c.req.param("id"))),
  handler,
);
// deny → 403 application/problem+json with permission, denials and alternatives
```

### MCP

```ts
import { createPermDock } from "permdock/mcp";

const { protectServer } = createPermDock(policy, {
  subject: (authInfo) => userFrom(authInfo),
});
protectServer(server).registerTool(
  "delete_post",
  {
    permission: permissions.post.delete,
    inputSchema,
    data: (args) => loadPost(args.id),
  },
  handler,
);
// tools filtered per caller, args validated, refusals carry reasons and alternatives
```

### AI SDK

```ts
import { createPermDock } from "permdock/ai-sdk";

const { toolApproval } = createPermDock(policy, {
  subject: ({ runtimeContext }) => runtimeContext.user,
  actor: ({ runtimeContext }) => ({
    id: runtimeContext.agentId,
    kind: "ai-sdk",
  }),
  tools: {
    delete_post: {
      permission: permissions.post.delete,
      data: (args) => loadPost(args.id),
    },
  },
});
generateText({ model, tools, toolApproval }); // granted → approved, denied → denied, approval-required → user-approval
```

### RLS

```bash
permdock rls generate --target drizzle --dialect supabase   # roles × grants → policies
permdock rls verify --db $DATABASE_URL                      # can() vs database parity
```

## Works with

Any Standard Schema validator: Zod, Valibot, ArkType, Effect Schema. One import path per target:

| Group              | Entries                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI                 | `permdock/react` · `permdock/react-native` · `permdock/vue` · `permdock/svelte` · `permdock/solid`                                                      |
| Full-stack         | `permdock/next`                                                                                                                                         |
| HTTP               | `permdock/server` · `permdock/hono` · `permdock/express` · `permdock/fastify` · `permdock/elysia` · `permdock/nest` · `permdock/node`                   |
| Terminal           | `permdock/terminal` for your own CLI (not the `permdock` binary)                                                                                        |
| RPC                | `permdock/trpc` · `permdock/orpc`                                                                                                                       |
| Agents             | `permdock/mcp` · `permdock/ai-sdk` · `permdock/claude-agent` · `permdock/eve` · `permdock/openai` · `permdock/webmcp` · `permdock/a2a`                  |
| Decision plane     | `permdock/authzen` · `permdock/approvals` · `permdock/cloud` · `permdock/scim` · `permdock/ssf` · `permdock/openapi` · `permdock/otel` · `permdock/pdp` |
| Data               | `permdock/drizzle` · `permdock/prisma` · `permdock/kysely` · `permdock rls`                                                                             |
| Auth and providers | `permdock/jwt` · `permdock/supabase` · `permdock/supabase/middleware` · `permdock/better-auth` · `permdock/clerk` · `permdock/convex`                   |
| Build              | `permdock/next/plugin` · `permdock/unplugin`                                                                                                            |
| Testing            | `permdock/testing`                                                                                                                                      |

Nuxt, Astro, React Router, TanStack Start and Effect use these entries plus `permdock/unplugin`. The full matrix with example apps and related standards is on the [adapters page](https://permdock.com/docs/adapters).

## Compared with

Other TypeScript permission libraries (CASL, permix, Kilpi, `@zap-studio/permit`) return booleans from string keys and stop at the server or the UI. Hosted PDPs (Cerbos, Permit.io, OpenFGA, SpiceDB) put a network call on every check. PermDock is an embedded, typed library with one decision object across UI, API, SQL, RLS and agent approvals. Read the [comparison](https://permdock.com/docs/comparison).

## For AI agents

```bash
npx skills add ScaleDockHQ/PermDock   # the permdock, permdock-wire, permdock-audit and topic skills
permdock skills                       # the same skills, offline, from node_modules/permdock/skills
```

Claude Code users can add the plugin marketplace instead: `/plugin marketplace add ScaleDockHQ/permdock`. Every docs page is served as Markdown, plus `llms.txt` and `llms-full.txt`. Read [for AI agents](https://permdock.com/docs/for-ai-agents).

## License

[MIT](https://github.com/ScaleDockHQ/permdock/blob/main/LICENSE) © 2026 ScaleDockHQ. Report vulnerabilities privately through [GitHub security advisories](https://github.com/ScaleDockHQ/permdock/security/advisories/new).
