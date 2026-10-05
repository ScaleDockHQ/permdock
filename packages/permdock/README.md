# permdock

**Typed permissions for TypeScript apps, APIs, databases and AI agents.**

[![npm](https://img.shields.io/npm/v/permdock?label=permdock)](https://www.npmjs.com/package/permdock)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/ScaleDockHQ/PermDock/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/ScaleDockHQ/PermDock/ci.yml?label=CI)](https://github.com/ScaleDockHQ/PermDock/actions)
![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-5fa04e.svg)
![TypeScript 7](https://img.shields.io/badge/TypeScript-7-3178c6.svg)

Define permissions once as typed references over the Zod, Valibot or ArkType schemas you already have. Grant them to roles with portable conditions. Check them in React, Next.js, Hono, tRPC, MCP servers and agent runtimes, and compile the same conditions to SQL `where` clauses and Postgres Row Level Security.

[Docs](https://permdock.com/docs) · [Quick start](https://permdock.com/docs/getting-started/quick-start) · [Adapters](https://permdock.com/docs/adapters) · [Existing apps](https://permdock.com/docs/getting-started/existing-apps) · [For AI agents](https://permdock.com/docs/for-ai-agents) · [Changelog](https://github.com/ScaleDockHQ/PermDock/blob/main/packages/permdock/CHANGELOG.md) · [Source](https://github.com/ScaleDockHQ/PermDock)

```bash
pnpm add permdock
```

One package: core, every adapter as a subpath export, the `permdock` CLI and `permdock/testing`. ESM only, Node.js 24 or later, built with TypeScript 7 and type-checked under 5.9 and 6. Runtime entries depend on `@standard-schema/spec` only; framework SDKs are optional peers.

## One definition, one decision

| Surface   | What PermDock gives it                                                                         |
| --------- | ---------------------------------------------------------------------------------------------- |
| UI        | A JSON snapshot with conditions, `<Protected>` and `usePermission`, answered offline           |
| HTTP, RPC | `protect` guards that answer a denial with RFC 9457 Problem Details                            |
| Database  | `where()` for Drizzle, Prisma and Kysely; generated Postgres RLS with a parity check           |
| Agents    | Filtered tool lists, model-readable refusals, human approvals with a replay-safe token         |
| CI        | A committed catalog, `permdock diff` that fails on a breaking change, `permdock doctor` checks |

Every check returns one of three outcomes: `granted`, `denied` or `approval-required`. Anything unknown, invalid or thrown denies, and a deny overrides an allow.

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

`permissions.post.update` is a frozen object, not a string: go-to-definition works, a rename is a type error everywhere it is used, and the definition is the catalog.

### 2. Write the policy

Server-only. Roles are data; conditions are a portable JSON tree.

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

`subjectFromClerk`, `subjectFromBetterAuth`, `subjectFromSupabase` and `subjectFromJwt` produce `memberships` from the provider you already use. PermDock stores no tenants, teams or memberships.

### 3. Decide

```ts
import { createPermDock } from "permdock";

const permdock = await createPermDock(policy, user); // frozen, request-scoped, never throws
permdock.can(permissions.post.update, post); // boolean
permdock.decide(permissions.post.delete, post); // { outcome: 'granted' | 'denied' | 'approval-required', ... }
permdock.explain(permissions.post.delete, post); // the decision plus a trace naming the deny that won
permdock.filter(permissions.post.read, posts); // Post[]
permdock.where(permissions.post.read); // portable condition for Drizzle / Prisma / Kysely / SQL
permdock.snapshot({ include: [permissions.post] }); // JSON for the client
```

## Use it where the check happens

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

The Claude Agent SDK, Eve, the OpenAI Agents SDK, WebMCP and A2A have their own entries with the same tool map.

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

### Postgres RLS

```bash
permdock rls generate --target drizzle --dialect supabase   # roles × grants → policies
permdock rls verify --db $DATABASE_URL                      # can() vs database parity
```

## Agents and approvals

An agent acts for a user, so a subject has two principals: the user (`principal`) and the agent (`actor`). Policy `delegations` cap what an actor may do for a user, and an approval grant pauses the call until people other than the requester approve it.

```ts
import { actor, allow, definePolicy } from "permdock";

const policy = definePolicy(permissions, {
  roles: [member, finance],
  delegations: [
    {
      from: roles.member,
      to: actor("eve"),
      permissions: [permissions.post.read, permissions.post.update],
      validUntil: "2027-06-01T00:00:00Z",
    },
  ],
  subject,
});

allow(permissions.payout.release, {
  approval: {
    by: roles.finance,
    quorum: 2, // two distinct finance approvers
    ttl: "30m",
    escalation: { after: "10m", to: roles.cfo },
  },
});
```

Approvers are authenticated and are never the agent, no one approves their own request by default, and the resumed call carries a token bound to the permission and the data. Read [delegation](https://permdock.com/docs/security/delegation) and [approvals](https://permdock.com/docs/security/approvals).

## Existing apps

PermDock adopts the permission keys, SQL helpers, tokens and stored custom roles an app already has, in steps that each leave the app working: generated helpers beside the hand-written SQL, `permdock rls migrate` to rewrite policies, and `renamed` aliases for keys you change later. `permdock doctor` reports what still uses an old key. Read [existing apps](https://permdock.com/docs/getting-started/existing-apps).

## CLI

| Command                  | What it does                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------ |
| `permdock collect`       | Scan the sources and write `permissions.catalog.json`; `--check` in CI               |
| `permdock diff a b`      | Compare two policies or catalogs; exit `1` on a breaking change; `--impact`          |
| `permdock doctor`        | Check wiring, imports, catalog freshness and security defaults; print a fix for each |
| `permdock usage`         | Report unused, ungranted and role-less permissions                                   |
| `permdock rls`           | `generate`, `import`, `verify` and `migrate` Postgres RLS policies                   |
| `permdock supabase hook` | Generate the Supabase Custom Access Token Hook from your membership sources          |
| `permdock openapi`       | Emit `security` into an OpenAPI document or Overlay, or import one                   |
| `permdock skills`        | Install the PermDock Agent Skills from `node_modules/permdock/skills`                |

`catalog`, `arazzo check` and `cloud push` complete the list. Every command takes `--json`; under it, a failure prints RFC 9457 Problem Details. Read [CLI](https://permdock.com/docs/cli).

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

## Secure by default

- Fail-closed: an unknown, invalid or thrown check denies, and `can()` never throws.
- Deny overrides allow, an unknown reference is a type error, and evaluation is prototype-safe with no eval.
- `service_role` is never emitted, a model-supplied subject is never trusted, and an agent with no delegation is denied.
- No one approves their own request by default, there is never a default tenant, and data is validated against the resource schema unless the caller marks a row it loaded `trusted: true`.
- Authentication stays upstream: PermDock consumes verified sessions, JWKS-verified JWTs (`permdock/jwt`, with `jose` as an optional peer), provider claims and MCP `authInfo`. Core never verifies a token. Read [authentication](https://permdock.com/docs/concepts/authentication).
- Every decision runs in-process. [PermDock Cloud](https://permdock.com/docs/adapters/cloud) adds a decision log, an approval inbox, a hosted AuthZEN endpoint and a SCIM relay, behind interfaces this package ships with in-process defaults.

Read the [threat model](https://permdock.com/docs/security/threat-model).

## Compared with

Other TypeScript permission libraries (CASL, permix, Kilpi, `@zap-studio/permit`) return booleans from string keys and stop at the server or the UI. Hosted PDPs (Cerbos, Permit.io, OpenFGA, SpiceDB) put a network call on every check. PermDock is an embedded, typed library with one decision object across UI, API, SQL, RLS and agent approvals. Read the [comparison](https://permdock.com/docs/comparison).

## For AI agents

```bash
npx skills add ScaleDockHQ/PermDock   # the permdock, permdock-wire, permdock-audit and topic skills
permdock skills                       # the same skills, offline, from node_modules/permdock/skills
```

Claude Code users can add the plugin marketplace instead: `/plugin marketplace add ScaleDockHQ/permdock`. Every docs page is served as Markdown, with `llms.txt`, `llms-full.txt` and a docs MCP server at `https://permdock.com/mcp`. Read [for AI agents](https://permdock.com/docs/for-ai-agents).

## License

[MIT](https://github.com/ScaleDockHQ/PermDock/blob/main/LICENSE) © 2026 ScaleDockHQ. Report vulnerabilities privately through [GitHub security advisories](https://github.com/ScaleDockHQ/PermDock/security/advisories/new).
