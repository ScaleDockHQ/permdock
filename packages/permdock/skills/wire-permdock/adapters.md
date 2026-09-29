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

Guard with `getPermission(permissions.post.update, post)` or `assert`. Client components use `permdock/react` inside the server `PermDockProvider`, which never awaits: it streams a `snapshotPromise` and only permission hooks suspend.

With `cacheComponents`, when permission UI (nav items, row actions) must be prefetched, the app owns the cache. Never put `'use cache'` inside PermDock calls, and never read `headers()` / `cookies()` in a function you mean to cache outside `'use cache: private'`:

```tsx
// src/permdock/snapshot.ts
import { cacheLife, cacheTag } from 'next/cache';
import { snapshotFor } from 'permdock';
import { cacheLifeFor } from 'permdock/next';

export async function loadSnapshot(org: string) {
  'use cache: private';
  const claims = await getClaims(); // verified locally against JWKS
  const snapshot = snapshotFor(policy, claims, { tenant: org });
  cacheLife(cacheLifeFor(snapshot));
  cacheTag(`permdock:${claims?.sub ?? 'anon'}`);
  return snapshot;
}

// app/[org]/layout.tsx: keep it synchronous
<PermDockProvider snapshotPromise={params.then(({ org }) => loadSnapshot(org))}>
```

After a role change: `updateTag('permdock:<user>')` in the Server Action; `revalidateTag(tag, { expire: 0 })` in a Route Handler. In `proxy.ts`, use `mayAccess(policy, claims, permission, { tenant })` (optimistic, never a decision). Both reach only the acting browser; for other members, add an app-owned signal (Realtime, poll, SSE) that calls `router.refresh()`. Keep the `[org]` layout synchronous and never read `cookies()` outside the private-cached loader. Guide: https://permdock.com/docs/guides/next-cache-components.

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

Every HTTP adapter takes `tenant` (for example `(c) => c.req.param('org')`), resolved again on each `protect` where route params exist, plus `limits` (a `LimitStore` for quota grants) and `pdp` (`createPermDock` from `permdock/pdp`). Pass `{ trusted: false }` as the third `protect` argument when the loader returns the request body. `assert` inside a handler becomes the same 403 Problem Details as a guard denial; no `onError` wiring is needed.

Streams and sockets: pass `revocations: memoryRevocationFeed()` (from `permdock`) and open a connection after `protect` succeeded. `sse` drops items the subscriber cannot read and ends with an `event: permdock` frame on revocation; await it last. `socket` closes a WebSocket with `1008`. Check inbound socket messages with `conn.check(permission, data, { trusted: false })`; a denial keeps the socket open.

```ts
app.get(
  '/projects/:id/events',
  protect(permissions.project.read, loadProject),
  async (c) => {
    const conn = await connection(c, {
      permission: permissions.project.read,
      data: c.get('permdockData'),
    });
    return streamSSE(c, async (stream) => {
      await sse(conn, stream, projectEvents(conn.signal), {
        items: permissions.project.read,
      });
    });
  },
);
```

Publish `revocations.revoke({ principal, tenant, kind: 'changed' })` from your role-edit code so open connections revalidate.

## React (Vite) — `permdock/react`

No factory. The server builds a snapshot (`permdock.snapshot()` or `fromSnapshot` on snapshot JSON) and the client wraps the tree:

```ts
import { PermDockProvider, Protected, usePermission } from 'permdock/react';
```

`permissions.ts` may be imported on the client. `policy.ts` may not.

## AI SDK — `permdock/ai-sdk`

```ts
import { createPermDock } from 'permdock/ai-sdk';
import { z } from 'zod';

const PostArgs = z.object({ id: z.string() });

export const { toolApproval, capabilityMiddleware, needsApproval } =
  createPermDock(policy, {
    subject: ({ runtimeContext }) => runtimeContext.user,
    actor: ({ runtimeContext }) => ({
      id: runtimeContext.agentId,
      kind: 'ai-sdk',
    }),
    // What the user handed the agent. No default: without it every tool is denied.
    delegation: () => ({ scopes: [permissions.post.delete.scope] }),
    tools: {
      delete_post: {
        permission: permissions.post.delete,
        // Tool input arrives as `unknown`: parse it before loading.
        data: (args) => loadPost(PostArgs.parse(args).id),
      },
    },
  });
```

Every agent adapter (`ai-sdk`, `claude-agent`, `openai`, `eve`) takes a `delegation` option: the scopes, `authorizationDetails` or `access` the user handed the agent. An actor with no delegation is denied every check with `no-delegation`; list the scopes explicitly, never the principal's whole role. Pass `toolApproval` into `generateText` / `ToolLoopAgent`. Wrap the model with `wrapLanguageModel({ model, middleware: capabilityMiddleware({ user }) })` per caller. Use `needsApproval(permissions.post.delete)` only on `WorkflowAgent`.

## Claude Agent SDK — `permdock/claude-agent`

```ts
import { createPermDock } from 'permdock/claude-agent';

export const { canUseTool, permissionRequestHook } = createPermDock(policy, {
  subject: () => user,
  actor: () => ({ id: 'claude', kind: 'claude-agent' }),
  delegation: () => ({ scopes: [permissions.post.delete.scope] }),
  tools: {
    delete_post: {
      permission: permissions.post.delete,
      data: (args) => loadPost(args),
    },
  },
});
```

`canUseTool` returns `{ behavior: 'allow', updatedInput }` or `{ behavior: 'deny', message }`; approval-required is a deny whose message carries the pending token. Pass a `store`: once a reviewer approves, the retried call is allowed exactly once. `mcp__` tools are trusted only from `mcpSources` (default `['sdk']`). Pass `permissionRequestHook` under `hooks.PermissionRequest`.

## Eve — `permdock/eve`

```ts
import { createPermDock } from 'permdock/eve';

export const { approval, approvalFor, permdock } = createPermDock(policy, {
  delegation: () => ({ scopes: [permissions.post.delete.scope] }),
  tools: {
    delete_post: {
      permission: permissions.post.delete,
      data: (args) => loadPost(args),
    },
  },
});
```

Pass `approval` as the tool's `approval`. Default subject/actor read `session.auth.initiator` / `current`. `approval.request(ctx)` maps granted to Eve's `not-applicable` (continue), approval-required to `user-approval`, denied to `{ type: 'denied', reason }`; Eve's re-check of a call nobody approved is denied. `approval.response(ctx)` maps the responder through the same `subject`. Use a durable `store` when replicas share sessions.

## OpenAI Agents SDK — `permdock/openai`

```ts
import { createPermDock } from 'permdock/openai';

export const { needsApproval, guardTools, resolveInterruptions, permdock } =
  createPermDock(policy, {
    subject: (ctx) => ctx.user,
    actor: (ctx) => ({ id: ctx.agentId, kind: 'openai' }),
    delegation: (ctx) => ({ scopes: ctx.scopes }),
    tools: {
      delete_post: {
        permission: permissions.post.delete,
        data: (args) => loadPost(args),
      },
    },
  });
```

`needsApproval(permission)` is the tool's `needsApproval`; it reads `runContext.context` and is true unless granted. `guardTools` drops tools with no grant. `resolveInterruptions(state, interruptions, { context })` approves or rejects each pause and returns the still-pending `ApprovalRequest`s. On resume, rebuild the context from the session and use `RunState.fromStringWithContext`.

## MCP — `permdock/mcp`

```ts
import { createPermDock } from 'permdock/mcp';

export const { protectServer } = createPermDock(policy, {
  subject: (authInfo) => userFrom(authInfo), // or subjectFromMcp
  requireAuthInfo: true, // HTTP behind bearer auth
  store,
});

const server = protectServer(
  new McpServer({ name: 'posts', version: '1.0.0' }),
);
server.registerTool(
  'delete_post',
  {
    permission: permissions.post.delete,
    inputSchema: z.object({ id: z.string() }),
    data: ({ id }) => loadPost(id),
  },
  handler,
);
```

`actor.kind` is `'mcp-client'`. Every `registerTool` / `registerResource` / `registerPrompt` needs a `permission`. Lists are filtered per caller. A missing scope is an `insufficient_scope` step-up (HTTP `403`). Denied calls return `isError: true` with Decision `structuredContent`. `approval-required` returns `isError: true` with the token and parks it in `store`; the retried call runs once after approval (token optional under `_meta["dev.permdock/approval"]`, never from tool arguments).

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

One Fetch handler serves `POST /access/v1/evaluation`, `/evaluations`, `/search/action`, `/search/resource`, `/search/subject` and `GET /.well-known/authzen-configuration`. PEP authentication is required (`401` unless `anonymous: true`). The body `subject` is the evaluation principal when the PEP is trusted (default). Unknown actions return `decision: false` with `context.reason: 'unknown-permission'`. Omit `subjects.list` to drop search/subject from discovery. A custom PDP that evaluates delegated callers outside `createPermDock` calls `coveredByDelegation(permission, delegation, resourceId, hasActor)` from `permdock` instead of re-implementing scope, `authorization_details` and GNAP `access` matching.

## OpenAPI — `permdock/openapi`

```ts
import { createPermDock } from 'permdock/openapi';

const { describe, securitySchemes, overlay } = createPermDock(policy, {
  scheme: { name: 'oauth', type: 'oauth2', flows: { authorizationCode: {} } },
  target: '3.2',
});
```

`describe(permission)` returns `security` plus `x-permdock-permissions`. `overlay({ version: '1.2' })` emits the pinned Overlay 1.2 draft. `target: '3.3'` emits the pinned Security Profile draft next to `x-permdock-securityProfile`. `scheme.type: 'gnap'` throws and emits nothing. CLI: `permdock openapi emit --doc openapi.json`; add `--arity` when a generated MCP server or SDK needs `x-permdock-arity` (instance or collection, and the id path parameter).

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

Fetch-native plugin via `derive`. Denials are `403 application/problem+json`; anonymous callers get `401` plus `WWW-Authenticate`. For `.ws` routes, `connection(ws, { permission })` in `open` returns the socket's connection (memoised); it closes the socket with `1008` when revoked.

## Nest — `permdock/nest`

```ts
import { createPermDock } from 'permdock/nest';

export const { PermDockModule, PermDockGuard, Protect, InjectPermDock } =
  createPermDock(policy, {
    subject: (request) => request.user ?? null,
  });
```

Register `PermDockGuard` as `APP_GUARD` with `useExisting`. `Protect` attaches a permission (and optional loader) to a handler or class. Denials are `403 application/problem+json`; anonymous callers get `401` plus `WWW-Authenticate`. Works on `@nestjs/platform-express` and `@nestjs/platform-fastify`. `permdockHandler({ path: ':org/permdock' })` mounts the decision controller where you choose. In a gateway, call `connection(client, client.request, { permission })` in `handleConnection` and `.close()` in `handleDisconnect`; `PermDockGuard` then checks each `@SubscribeMessage` through it.

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

Converts `IncomingMessage` to Fetch, then delegates to `permdock/server`. Denials are `403 application/problem+json`; anonymous callers get `401` plus `WWW-Authenticate`. Express and Nest reuse `toRequest` / `fromResponse`. The body is read only when consumed, so a body parser after `permdock(req)` still works. There is no error hook: wrap handlers that call `assert` and `send(res, problemFromError(error))` (from `permdock/server`) when it returns a `Response`.

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

`protect` throws `TRPCError` (`FORBIDDEN`, `BAD_REQUEST`, `UNAUTHORIZED`) with Problem Details as `cause`; pass `errorFormatter` to `initTRPC.create` so clients see it under `data`. `ctx.permdock.assert` in a resolver maps to the same error. Read the tenant from each procedure's input (`tenant: (opts) => opts.input?.org`) so a batch never shares one; `request: (ctx) => ctx.req` names the Web `Request` when the context holds it elsewhere. `openapi.security(permission)` is the `trpc-to-openapi` meta fragment. On a subscription, `protect(permission, load, { items })` ends the iterator with `UNAUTHORIZED` or `FORBIDDEN` when the session is revoked or the permission re-denied, and drops items the subscriber cannot read; pass `revocations`.

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

`protect` throws `ORPCError` (`FORBIDDEN`, `BAD_REQUEST`, `UNAUTHORIZED`) with Problem Details as `data`, and so does `context.permdock.assert` in a handler. Read the tenant from each procedure's input. `openapi.protect` is the same guard; pass `openapi.security(permission)` to oRPC 2's `openapi({ spec })` metadata helper. Event iterators behind `protect(permission, load, { items })` end and filter like tRPC subscriptions.

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
import { approvalHeaders, usePermDock } from 'permdock/react';

const permdock = usePermDock();
const controller = new AbortController();
registerTools(document.modelContext, permissions.post, {
  permdock,
  signal: controller.signal,
  handlers: {
    update: async ({ input, token }) =>
      api.posts.update(input, { headers: approvalHeaders(token) }),
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

The handler writes users and groups. It never decides. Unknown or non-assignable role names are stored and dropped when memberships are read. Pass the app's `revocations` feed so a deprovisioned member's open streams revalidate and close.

## Cloud — `permdock/cloud`

No factory for a `PermDock`. `cloud({ url, key, environment })` returns `approvals`, `sink`, `snapshots` and `policies` to pass into any adapter, plus the environment `issuer` (`<url>/v1/environments/<environment>`) and its `jwks` URL; `cloudEndpoints({ url, environment })` computes the same two without a key. It never implements `MembershipSource` or `RoleSource` and never decides.

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

Hosted grants are opt-in per permission. List the permissions a Cloud admin may grant in `definePolicy(..., { hostable: [permissions.auditLog.read] })`, pass `verifier: joseTokenVerifier({ jwks: cloudEndpoints({ url, environment }).jwks })` to `cloud()` (the policy document's issuer and audience are both the environment URL), forward `policies: pd.policies`, and call `pd.policies.refresh()` on a timer. Never mark a permission `hostable` when `permdock rls` compiles its table (`permdock doctor` PD020).

`PERMDOCK_CLOUD_URL` and `PERMDOCK_CLOUD_KEY` are server-only. Production `PERMDOCK_CLOUD_URL` is `https://api.permdock.com`. The dashboard is `https://app.permdock.com`; the read-only MCP server is `https://mcp.permdock.com`. A Cloud outage leaves directory memberships at their last synced state.

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

No `@supabase/supabase-js` peer. Pair with `permdock rls generate`, or keep SQL as authority and run `permdock rls verify --db` against `sqlFunction` twins ([database-first](/docs/adapters/rls)).

`claims` is whatever Supabase verified: `data.claims` from `supabase.auth.getClaims()` on an `@supabase/ssr` server client, or `jwtClaims` from `@supabase/server` (`ctx.jwtClaims` in `withSupabase`, `c.var.supabaseContext.jwtClaims` in its Hono adapter). Pass `null` for anonymous callers; never `getSession().access_token` (unverified). An API-key auth mode (`secret`, `publishable`) has `jwtClaims: null` and is the anonymous subject, not a user.

## Supabase middleware pipeline — `permdock/supabase/middleware`

```ts
import { pipeline } from '@supabase/middleware';
import { withClaims } from '@supabase/server/middleware/claims';
import { subjectFromSupabase } from 'permdock/supabase';
import { createPermDock } from 'permdock/supabase/middleware';

const { withPermDock, permdockHandler } = createPermDock(policy, {
  subject: (ctx) =>
    subjectFromSupabase(ctx.jwtClaims, {
      roles: 'user_role',
      declared: ['member', 'admin'],
    }),
});

// ctx.permdock inside the handler
export default {
  fetch: pipeline([withClaims(), withPermDock()], async (req, ctx) =>
    ctx.permdock.can(permissions.post.update, await loadPost(req))
      ? Response.json({ ok: true })
      : Response.json({ ok: false }, { status: 403 }),
  ),
};

// or a route guard with Problem Details
pipeline(
  [
    withClaims(),
    withPermDock({
      protect: permissions.post.publish,
      data: (_ctx, req) => loadPost(req),
    }),
  ],
  handler,
);

// AuthZEN evaluations
pipeline([withClaims()], permdockHandler());
```

`@supabase/middleware` is the optional peer (already installed with `@supabase/server`). `withPermDock` requires `jwtClaims` upstream: place it after `withClaims` or `withRequiredClaims`, never first. Run `ctx.supabaseAdmin` / `withPostgresAdminClient` only after `ctx.permdock.assert(...)`; they bypass RLS.

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

Use `createPermDock` from `permdock/pdp` when `providers` is set. Core `can` / `decide` stay synchronous and deny delegated permissions with `pdp-unavailable`; on the PDP instance `filter` and `where` are async too.

For OpenFGA or SpiceDB, use `openfga({ url, storeId, map })` or `spicedb({ url, token, map })` as the provider. `map` is one `[permission, (subject, row) => tuple]` pair per delegated permission; `filter` and `where` then use `list-objects` / `LookupResources` ids, so the tuple ids must equal the resource's `id` field. The app writes the tuples.

## Collect-only frameworks (no package)

Nuxt, Astro, React Router, TanStack Start and Effect have no `permdock/<name>` entry. Add `createPermDockUnplugin.vite()` from `@permdock/cli/unplugin` (or `.webpack` / `.esbuild`). Runtime is `permdock/server` or the matching HTTP adapter, plus `permdock/vue`, `permdock/react` or `permdock/svelte` on the client. Effect Schema is a Standard Schema; Effect HttpApi uses Overlay, not a hook.

Remaining work follows the names on the adapter page under `/docs/adapters/<name>`. Do not invent identifiers.

```bash
pnpm exec permdock rls generate --target sql --dialect supabase --out migrations/rls.sql
pnpm exec permdock rls generate --target sql --dialect supabase --rbac supabase --authorize database --memberships organization_members:organization_id,user_id,role --tenant-type uuid
pnpm exec permdock rls import --sql migrations/rls.sql --out src/permissions.generated.ts
pnpm exec permdock rls verify --fixtures rls.fixtures.json
pnpm exec permdock rls verify --db $DATABASE_URL --fixtures rls.fixtures.json
```

Generated policies call `permdock_has('<key>')` and `permitted_tenant_ids('<key>')` / `permitted_team_ids('<key>')`, which Postgres runs once per statement; set `--tenant-type` (or `rls.tenantType`) to the tenant column's type. `--policy-per-role` keeps one policy per role for review. With tenant-defined custom roles, add `--custom-roles` (or `rls.customRoles: true`): write `custom_role_permissions` / `custom_role_includes` from the server in `database` mode, or put `customRoleClaim(roles)` on each membership's `grants` in the token in `jwt` mode. Both stay inside the `permdock_ceiling` view.

When SQL is the authority, skip `generate`. Map helpers in `rls.functions`, write `sqlFunction` twins, and fail CI on `verify --db`. `--inline-functions` inlines the twin for generate targets that cannot call a SQL function.

Never emit `service_role`. Fixtures may carry `memberships` and `tenant`, and a fixture file may add `customRoles`.

Add `--force` (or `rls.force: true`) only when the application connects as the table owner; it emits `FORCE ROW LEVEL SECURITY`. Create views over RLS tables `with (security_invoker = true)`; `permdock doctor` PD022 warns on views that are not. When `rls import` prints a commented `rls.memberships.tenant` stanza, confirm the table holds memberships before pasting it.

`--authorize database` (default) makes `authorize()` read `user_roles` and the membership table per statement. `--authorize jwt` reads the hook's claims and stays stale until the token refreshes; keep `jwt_expiry` at 3600 or less (doctor PD019). Enable the printed `[auth.hook.custom_access_token]` stanza in `supabase/config.toml`.
