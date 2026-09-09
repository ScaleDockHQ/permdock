# Adapter factories

Every server and agent adapter exports `createPermDock`. The import path names the framework. React has no factory: it exports hooks and `<Protected>` from `permdock/react`.

## Next.js — `permdock/next`

File: `src/permdock/server.ts`

```ts
import { createPermDock } from 'permdock/next';
import { policy } from '../policy';

export const { getPermDock, getPermission, PermDockProvider, permdockHandler } =
  createPermDock(policy, {
    subject: async () => getUser(),
  });
```

Guard with `getPermission(permissions.post.update, post)` or `assert`. Client components use `permdock/react` inside the server `PermDockProvider`.

## Hono — `permdock/hono`

```ts
import { createPermDock, discoverViaSignatureAgent } from 'permdock/hono';

export const { permdock, protect, permdockHandler } = createPermDock(policy, {
  subject: (c) => c.get('user'),
  webBotAuth: {
    verify: true,
    keys: discoverViaSignatureAgent({ allow: ['agents.example.com'] }),
  },
});

app.use('*', permdock());
app.delete(
  '/posts/:id',
  protect(permissions.post.delete, (c) => loadPost(c)),
  handler,
);
```

## React (Vite) — `permdock/react`

No factory. The server builds a snapshot (`permdock.snapshot()` or `fromSnapshot` on snapshot JSON) and the client wraps the tree:

```ts
import { PermDockProvider, Protected, usePermission } from 'permdock/react';
```

`permissions.ts` may be imported on the client. `policy.ts` may not.

## AI SDK — `permdock/ai-sdk`

```ts
import { createPermDock } from 'permdock/ai-sdk';

export const { toolApproval, capabilityMiddleware, needsApproval } =
  createPermDock(policy, {
    subject: ({ runtimeContext }) => runtimeContext.user,
    actor: ({ runtimeContext }) => ({
      id: runtimeContext.agentId,
      kind: 'ai-sdk',
    }),
    tools: {
      delete_post: {
        permission: permissions.post.delete,
        data: (args) => loadPost(args.id),
      },
    },
  });
```

Pass `toolApproval` into `generateText` / `ToolLoopAgent`. Wrap the model with `capabilityMiddleware`. Use `needsApproval(permissions.post.delete)` only on `WorkflowAgent`.

## Claude Agent SDK — `permdock/claude-agent`

```ts
import { createPermDock } from 'permdock/claude-agent';

export const { canUseTool, permissionRequestHook } = createPermDock(policy, {
  subject: () => user,
  actor: () => ({ id: 'claude', kind: 'claude-agent' }),
  tools: {
    delete_post: {
      permission: permissions.post.delete,
      data: (args) => loadPost(args),
    },
  },
});
```

`canUseTool` returns `{ behavior: 'allow', updatedInput }`, `{ behavior: 'deny', message }`, or `null` while approval is pending. Resume with `token` / `approval` on the context.

## Eve — `permdock/eve`

```ts
import { createPermDock } from 'permdock/eve';

export const { approval, approvalFor, permdock } = createPermDock(policy, {
  tools: {
    delete_post: {
      permission: permissions.post.delete,
      data: (args) => loadPost(args),
    },
  },
});
```

Default subject/actor read `session.auth.initiator` / `current`. `approval.request` maps granted to Eve's `not-applicable` (continue), approval-required to `user-approval`, denied to `{ type: 'denied', reason }`.

## OpenAI Agents SDK — `permdock/openai`

```ts
import { createPermDock } from 'permdock/openai';

export const { needsApproval, guardTools, resolveInterruptions, permdock } =
  createPermDock(policy, {
    subject: (ctx) => ctx.user,
    actor: (ctx) => ({ id: ctx.agentId, kind: 'openai' }),
    tools: {
      delete_post: {
        permission: permissions.post.delete,
        data: (args) => loadPost(args),
      },
    },
  });
```

`needsApproval` is true unless the decision is granted. `guardTools` drops tools with no grant. `resolveInterruptions` approves or rejects each pause.

## MCP — `permdock/mcp`

```ts
import { createPermDock } from 'permdock/mcp';

export const { protectServer } = createPermDock(policy, {
  subject: (authInfo) => authInfo.extra?.subject ?? null,
});

const guarded = protectServer(server);
guarded.registerTool(
  'delete_post',
  { permission: permissions.post.delete, data: (args) => loadPost(args) },
  handler,
);
```

`actor.kind` is `'mcp-client'`. Missing scopes throw `InsufficientScopeError` (HTTP `403 insufficient_scope`). Denied calls return `isError: true` with Decision `structuredContent`. `approval-required` returns an elicitation payload; resume only from `authInfo.extra.approval`, never from tool arguments.

## AuthZEN — `permdock/authzen`

```ts
import { createPermDock } from 'permdock/authzen';

export const { handler } = createPermDock(policy, {
  subject: fromBearer,
  resources: {
    post: { load: (id) => loadPost(id), list: () => listPosts() },
  },
});
```

One Fetch handler serves `POST /access/v1/evaluation`, `/evaluations`, `/search/action`, `/search/resource`, `/search/subject` and `GET /.well-known/authzen-configuration`. PEP authentication is required (`401` unless `anonymous: true`). The body `subject` is the evaluation principal when the PEP is trusted (default). Unknown actions return `decision: false` with `context.reason: 'unknown-permission'`. Omit `subjects.list` to drop search/subject from discovery.

## OpenAPI — `permdock/openapi`

```ts
import { createPermDock } from 'permdock/openapi';

const { describe, securitySchemes, overlay } = createPermDock(policy, {
  scheme: { name: 'oauth', type: 'oauth2', flows: { authorizationCode: {} } },
  target: '3.2',
});
```

`describe(permission)` returns `security` plus `x-permdock-permissions`. `overlay({ version: '1.2' })` emits the pinned Overlay 1.2 draft. `target: '3.3'` emits the pinned Security Profile draft next to `x-permdock-securityProfile`. `scheme.type: 'gnap'` throws and emits nothing. CLI: `permdock openapi emit --doc openapi.json`.

## React Native — `permdock/react-native`

No factory. Same hooks and `<Protected>` as `permdock/react`, plus `storage` so Expo Router `Stack.Protected` can answer on the first frame:

```ts
import { PermDockProvider, usePermission } from 'permdock/react-native';
```

`storage` is `{ getItem, setItem, removeItem }` (MMKV, SecureStore, AsyncStorage). `snapshotUrl` revalidates in the background. `permdock.clear()` drops the persisted snapshot on sign-out. Do not import `policy.ts` on the client.

## Express — `permdock/express`

```ts
import { createPermDock } from 'permdock/express';

export const { permdock, protect, errorHandler } = createPermDock(policy, {
  subject: (req) => req.user ?? null,
});

app.use(permdock());
app.delete(
  '/posts/:id',
  protect(permissions.post.delete, (req) => loadPost(req.params.id)),
  handler,
);
app.use(errorHandler());
```

Converts `IncomingMessage` to Fetch, then delegates to `permdock/server`. Denials are `403 application/problem+json`; anonymous callers get `401` plus `WWW-Authenticate`.

## Fastify — `permdock/fastify`

```ts
import { createPermDock } from 'permdock/fastify';

export const { permdock, protect } = createPermDock(policy, {
  subject: (request) => request.user ?? null,
});

await app.register(permdock);
app.delete(
  '/posts/:id',
  {
    preHandler: protect(permissions.post.delete, (request) =>
      loadPost(request.params.id),
    ),
  },
  handler,
);
```

Registers a `fastify-plugin`-style root plugin (`skip-override`) that decorates `request.permdock`. Denials are `403 application/problem+json`; anonymous callers get `401` plus `WWW-Authenticate`.

## Elysia — `permdock/elysia`

```ts
import { createPermDock } from 'permdock/elysia';

export const { permdock, protect } = createPermDock(policy, {
  subject: ({ store }) => store.user ?? null,
});

const app = new Elysia().use(permdock()).delete('/posts/:id', handler, {
  beforeHandle: protect(permissions.post.delete, ({ params }) =>
    loadPost(params.id),
  ),
});
```

Fetch-native plugin via `derive`. Denials are `403 application/problem+json`; anonymous callers get `401` plus `WWW-Authenticate`.

## Nest — `permdock/nest`

```ts
import { createPermDock } from 'permdock/nest';

export const { PermDockModule, PermDockGuard, Protect, InjectPermDock } =
  createPermDock(policy, {
    subject: (request) => request.user ?? null,
  });
```

Register `PermDockGuard` as `APP_GUARD` with `useExisting`. `Protect` attaches a permission (and optional loader) to a handler or class. Denials are `403 application/problem+json`; anonymous callers get `401` plus `WWW-Authenticate`.

## Node — `permdock/node`

```ts
import { createPermDock } from 'permdock/node';

export const { permdock, protect, send, permdockHandler } = createPermDock(
  policy,
  {
    subject: (req) => userFromCookie(req.headers.cookie),
  },
);
```

Converts `IncomingMessage` to Fetch, then delegates to `permdock/server`. Denials are `403 application/problem+json`; anonymous callers get `401` plus `WWW-Authenticate`. Express and Nest reuse `toRequest` / `fromResponse`.

## tRPC — `permdock/trpc`

```ts
import { createPermDock } from 'permdock/trpc';

export const { permdock, protect, permdockHandler } = createPermDock(policy, {
  subject: (opts) => opts.ctx.user ?? null,
});

const procedure = t.procedure.use(permdock());
procedure
  .input(z.object({ id: z.string() }))
  .use(protect(permissions.post.delete, ({ input }) => loadPost(input.id)))
  .mutation(({ ctx }) => deletePost(ctx.permdockData));
```

`protect` throws `TRPCError` (`FORBIDDEN`, `BAD_REQUEST`, `UNAUTHORIZED`) with Problem Details as `cause`. `openapi.security(permission)` is the `trpc-to-openapi` meta fragment.

## oRPC — `permdock/orpc`

```ts
import { createPermDock } from 'permdock/orpc';

export const { permdock, protect, permdockHandler } = createPermDock(policy, {
  subject: ({ context }) => context.user ?? null,
});

const base = os.$context<Context>().use(permdock());
base
  .input(z.object({ id: z.string() }))
  .use(protect(permissions.post.delete, ({ input }) => loadPost(input.id)))
  .handler(({ context }) => deletePost(context.permdockData));
```

`protect` throws `ORPCError` (`FORBIDDEN`, `BAD_REQUEST`, `UNAUTHORIZED`) with Problem Details as `data`. `openapi.protect` is the same guard plus the kernel `security` fragment for `oo.spec`.

## Vue — `permdock/vue`

```ts
import { permdockPlugin, Protected, usePermission } from 'permdock/vue';

createApp(App).use(permdockPlugin, { snapshot, endpoint: '/api/permdock' });
```

Composables return refs (`allowed`, `status`, `decision`). Do not import `policy.ts` on the client.

## Svelte — `permdock/svelte`

```ts
import { setPermDock, permission, Protected } from 'permdock/svelte';

setPermDock({ snapshot, endpoint: '/api/permdock' });
const canEdit = permission(permissions.post.update, () => post);
```

Stores are readable (`$canEdit.allowed`). Do not import `policy.ts` on the client.

## Solid — `permdock/solid`

```ts
import { PermDockProvider, Protected, usePermission } from 'permdock/solid';

<PermDockProvider snapshot={snapshot} endpoint="/api/permdock">
  <App />
</PermDockProvider>
```

`usePermission` takes an accessor for instance data (`() => post`). Do not import `policy.ts` on the client.

## Terminal — `permdock/terminal`

```ts
import { createPermDock } from 'permdock/terminal';

export const { permdock, protect, filterCommands, format, exitCode } =
  createPermDock(policy, {
    subject: async ({ token }) => {
      const jwt = await token(['env', 'keychain', 'ci-oidc', 'device']);
      return jwt ? subjectFromJwt(jwt, { issuer, audience: 'acme-cli' }) : null;
    },
  });
```

Not `@permdock/cli`. Never accept `--user` or `--actor` as identity.

## WebMCP — `permdock/webmcp`

Client entry. No factory. Register snapshot-allowed tools on `document.modelContext`:

```ts
import { registerTools } from 'permdock/webmcp';
import { usePermDock } from 'permdock/react';

const permdock = usePermDock();
const controller = new AbortController();
registerTools(document.modelContext, permissions.post, {
  permdock,
  signal: controller.signal,
  handlers: {
    update: async (input) => api.posts.update(input),
  },
});
```

Never import a policy into this entry. A missing `document.modelContext` is a no-op.

## A2A — `permdock/a2a`

```ts
import { createPermDock } from 'permdock/a2a';

export const { agentCard, extendedAgentCard, protectSkill } = createPermDock(
  policy,
  {
    subject: (auth) => userFrom(auth),
    card: {
      name: 'Posts agent',
      url: 'https://agent.example.com/a2a',
      version: '1.0.0',
    },
    securitySchemes: { oauth: { type: 'oauth2' } },
    skills: {
      summarise: { permission: permissions.post.read },
    },
  },
);
```

Identity comes from transport auth, never the task body.

## OpenTelemetry — `permdock/otel`

```ts
import { instrument } from 'permdock/otel';

instrument(permdock, {
  logger: { info: console.info, warn: console.warn },
});
```

HTTP adapters accept the same options as `otel`. `@opentelemetry/api` is optional; without it the adapter writes only through `logger`.

## SCIM — `permdock/scim`

No factory. Mount `scimHandler` and pass `directoryMembershipSource(store)` as `memberships`:

```ts
import {
  scimHandler,
  memoryDirectoryStore,
  directoryMembershipSource,
  tenantFromPath,
} from 'permdock/scim';

const directory = memoryDirectoryStore();
export const scim = scimHandler({
  store: directory,
  tenant: (request) => tenantFromPath(request),
  token: { hash: 'sha256', lookup: (tenant) => hashFor(tenant) },
});
```

The handler writes users and groups. It never decides. Unknown or non-assignable role names are stored and dropped when memberships are read.

## Cloud — `permdock/cloud`

No factory for a `PermDock`. `cloud({ url, key })` returns `approvals`, `sink` and `snapshots` to pass into any adapter. It never implements `MembershipSource` or `RoleSource` and never decides.

```ts
import { cloud } from 'permdock/cloud';

const pd = cloud({
  url: process.env.PERMDOCK_CLOUD_URL,
  key: process.env.PERMDOCK_CLOUD_KEY,
});

export const { getPermDock } = createPermDock(policy, {
  subject,
  store: pd.approvals,
  sink: pd.sink,
  snapshots: pd.snapshots,
});
```

`PERMDOCK_CLOUD_URL` and `PERMDOCK_CLOUD_KEY` are server-only. A Cloud outage leaves directory memberships at their last synced state.

## Better Auth — `permdock/better-auth`

```ts
import {
  subjectFromBetterAuth,
  betterAuthRoleSource,
} from 'permdock/better-auth';

const session = await auth.api.getSession({ headers });
const subject = await subjectFromBetterAuth(auth, session);
const permdock = await createPermDock(policy, subject, {
  customRoles: betterAuthRoleSource(auth),
});
```

Pass the server `getSession` result only. A null session is anonymous. Never call `hasPermission` on the request path.

## Clerk — `permdock/clerk`

```ts
import { subjectFromClerk } from 'permdock/clerk';

export const { getPermDock } = createPermDock(policy, {
  subject: async () => subjectFromClerk(await auth()),
});
```

Pass `auth()` or a verified session payload only. A plain `{ userId }` object is anonymous. `memberships: 'all'` loads organizations through the Clerk Backend API.

## Convex — `permdock/convex`

```ts
import { createPermDock } from 'permdock/convex';

export const { withPermDock, snapshotQuery } = createPermDock(policy, {
  subject: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    return identity && { id: identity.subject, roles: ['member'] };
  },
});
```

Identity comes from `ctx` only. Function arguments never influence the subject. `assert` becomes a ConvexError with RFC 9457 Problem Details.

## Approvals — `permdock/approvals`

```ts
import { approvalsHandler, memoryApprovalStore } from 'permdock/approvals';

const store = memoryApprovalStore();
export const { GET, POST } = approvalsHandler({
  store,
  decide,
  subject: fromSession,
});
```

Pass `store` into every adapter `createPermDock`. Resume HTTP with `PermDock-Approval`.

## JWT — `permdock/jwt`

```ts
import { subjectFromJwt } from 'permdock/jwt';

const subject = await subjectFromJwt(token, {
  discovery: 'https://issuer.example.com',
  audience: 'https://api.example.com',
});
```

`jose` is an optional peer. Failures become the anonymous subject, never a throw.

## Drizzle / Prisma / Kysely

```ts
import { toWhere } from 'permdock/drizzle'; // or permdock/prisma, permdock/kysely
const where = toWhere(dock.where(permissions.post.list), posts);
```

Prisma also exports `permdockExtension`. Kysely also exports `withSubject`. Prisma is structurally typed (no peer).

## Supabase — `permdock/supabase`

```ts
import { subjectFromSupabase, authorizeSql } from 'permdock/supabase';

const subject = subjectFromSupabase(claims, {
  roles: 'user_role',
  tenant: 'tenant_id',
  memberships: 'memberships',
  declared: ['member', 'admin'],
});
```

No `@supabase/supabase-js` peer. Pair with `permdock rls generate`.

## Remote PDP — `permdock/pdp`

```ts
import { createPermDock, remotePdp } from 'permdock/pdp';

const policy = definePolicy(permissions, {
  roles: [member],
  subject: (user) => user && { id: user.id, roles: user.roles },
  providers: [
    remotePdp({ url: process.env.PDP_URL, auth: { bearer: () => token } }),
  ],
});

const permdock = await createPermDock(policy, user);
await permdock.can(permissions.post.read, post);
```

Use `createPermDock` from `permdock/pdp` when `providers` is set. Core `can` / `decide` stay synchronous and deny delegated permissions with `pdp-unavailable`.

## Collect-only frameworks (no package)

Nuxt, Astro, React Router, TanStack Start and Effect have no `permdock/<name>` entry. Add `createPermDockUnplugin.vite()` from `@permdock/cli/unplugin` (or `.webpack` / `.esbuild`). Runtime is `permdock/server` or the matching HTTP adapter, plus `permdock/vue`, `permdock/react` or `permdock/svelte` on the client. Effect Schema is a Standard Schema; Effect HttpApi uses Overlay, not a hook.

Remaining work follows the names on the adapter page under `/docs/adapters/<name>`. Do not invent identifiers.

```bash
pnpm exec permdock rls generate --target sql --dialect supabase --out migrations/rls.sql
pnpm exec permdock rls generate --target sql --dialect supabase --rbac-scaffold --memberships organization_members:organization_id,user_id,role
pnpm exec permdock rls import --sql migrations/rls.sql --out src/permissions.generated.ts
pnpm exec permdock rls verify --fixtures rls.fixtures.json
```

Never emit `service_role`. Fixtures may carry `memberships` and `tenant`.
