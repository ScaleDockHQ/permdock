# Adapter factories

Every server adapter exports `createPermDock`. The import path names the framework. Agent runtime adapters (AI SDK, Claude Agent SDK, Eve, OpenAI Agents SDK, MCP, A2A, WebMCP, terminal) are in the `permdock-agents` skill; ORM adapters and Convex in the `permdock-data` skill. React has no factory: it exports hooks and `<Protected>` from `permdock/react`.

## Next.js — `permdock/next`

File: `src/permdock/server.ts`

```ts
import { createPermDock } from "permdock/next";
import { policy } from "../policy";

export const {
  getPermDock,
  getPermission,
  requireAccess,
  PermDockProvider,
  permdockHandler,
} = createPermDock(policy, {
  subject: async () => getUser(),
});
```

Needs Next.js 16.3 or later. Guard with `getPermission(permissions.post.update, post)` or `assert`. For a page or Server Action that must stop on a denial, `await requireAccess({ permission, data, tenant })` calls `forbidden()` (or `unauthorized()` for a signed-out user); enable `experimental.authInterrupts` and add `app/forbidden.tsx` and `app/unauthorized.tsx`. When only part of a page is gated, let a Server Component `assert` inside `<PermissionBoundary denied={...} approval={...}>` from `permdock/next/client` (with a `Suspense` inside it); `usePermissionBoundary()` in the fallback gives the permission, the approval `token` and `retry()`. Client components use `permdock/react` inside the server `PermDockProvider`, which never awaits: it streams a `snapshotPromise` and only permission hooks suspend.

With `cacheComponents`, when permission UI (nav items, row actions) must be prefetched, the app owns the cache. Never put `'use cache'` inside PermDock calls, and never read `headers()` / `cookies()` in a function you mean to cache outside `'use cache: private'`:

```tsx
// src/permdock/snapshot.ts
import { cacheLife, cacheTag } from 'next/cache';
import { snapshotFor } from 'permdock';
import { cacheLifeFor, snapshotTag } from 'permdock/next';

export async function loadSnapshot(org: string) {
  'use cache: private';
  const claims = await getClaims(); // verified locally against JWKS
  const snapshot = snapshotFor(policy, claims, { tenant: org });
  cacheLife(cacheLifeFor(snapshot));
  cacheTag(snapshotTag(claims?.sub));
  return snapshot;
}

// app/[org]/layout.tsx: keep it synchronous
<PermDockProvider snapshotPromise={params.then(({ org }) => loadSnapshot(org))}>
```

After a role change: `updateTag(snapshotTag(user))` in the Server Action; `revalidateTag(tag, { expire: 0 })` in a Route Handler (not `'max'`, which would keep serving the revoked grant). Pages whose permission UI must be instant export `instant = true`; a rarely visited admin page exports `prefetch = 'force-disabled'`. Resource links that should carry their gated actions use `<Link prefetch={true}>` with the check in a `'use cache: private'` function keyed on the resource id. In `proxy.ts`, use `mayAccess(policy, claims, permission, { tenant })` (optimistic, never a decision). Both reach only the acting browser; for other members, add an app-owned signal (Realtime, poll, SSE) that calls `router.refresh()`. Keep the `[org]` layout synchronous and never read `cookies()` outside the private-cached loader. With a slug in the URL (`[orgSlug]`), resolve it to the org id in a `'use cache'` lookup that reads no session, call `notFound()` for an unknown slug, and pass the id to `snapshotFor`, `requireAccess` and `getPermDock`. Export `const { POST, GET } = permdockHandler()` from `app/api/permdock/route.ts`, or pass `endpoint: false` when every client check is portable; then a closure grant read by `usePermission` is denied with reason `server-only` (`permdock doctor` PD044 warns). Guide: [Next.js Cache Components](https://permdock.com/docs/guides/next-cache-components).

## Hono — `permdock/hono`

```ts
import { createPermDock } from "permdock/hono";

export const { permdock, protect, permdockHandler } = createPermDock(policy, {
  subject: (c) => c.get("user"),
});

app.use("*", permdock());
app.delete(
  "/posts/:id",
  protect(permissions.post.delete, (c) => loadPost(c)),
  handler,
);
```

Every HTTP adapter takes `tenant` (for example `(c) => c.req.param('org')`), resolved again on each `protect` where route params exist, plus `limits` (a `LimitStore` for quota grants) and `pdp` (`createPermDock` from `permdock/pdp`). A `protect` loader's result is validated against the resource schema; pass `{ trusted: true }` as the third argument only when the loader returns a row the server loaded itself. `assert` inside a handler becomes the same 403 Problem Details as a guard denial; no `onError` wiring is needed.

Streams and sockets: pass `revocations: memoryRevocationFeed()` (from `permdock`) and open a connection after `protect` succeeded. `sse` drops items the subscriber cannot read and ends with an `event: permdock` frame on revocation; await it last. `socket` closes a WebSocket with `1008`. Check inbound socket messages with `conn.check(permission, data)`, which validates the message data; a denial keeps the socket open.

```ts
app.get(
  "/projects/:id/events",
  protect(permissions.project.read, loadProject),
  async (c) => {
    const conn = await connection(c, {
      permission: permissions.project.read,
      data: c.get("permdockData"),
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
import { PermDockProvider, Protected, usePermission } from "permdock/react";
```

`permissions.ts` may be imported on the client. `policy.ts` may not.

## AuthZEN — `permdock/authzen`

```ts
import { createPermDock } from "permdock/authzen";

export const { permdockHandler } = createPermDock(policy, {
  subject: fromBearer,
  resources: {
    post: { load: (id) => loadPost(id), list: () => listPosts() },
  },
});
```

One Fetch handler serves `POST /access/v1/evaluation`, `/evaluations`, `/search/action`, `/search/resource`, `/search/subject` and `GET /.well-known/authzen-configuration`. PEP authentication is required (`401` unless `anonymous: true`). The body `subject` is the evaluation principal when the PEP is trusted (default). Unknown actions return `decision: false` with `context.reason: 'unknown-permission'`. Omit `subjects.list` to drop search/subject from discovery. A custom PDP that evaluates delegated callers outside `createPermDock` calls `coveredByDelegation(permission, delegation, resourceId, hasActor)` from `permdock` instead of re-implementing scope, `authorization_details` and GNAP `access` matching.

## OpenAPI — `permdock/openapi`

```ts
import { createPermDock } from "permdock/openapi";

const { describe, securitySchemes, overlay } = createPermDock(policy, {
  scheme: { name: "oauth", type: "oauth2", flows: { authorizationCode: {} } },
  target: "3.2",
});
```

`describe(permission)` returns `security` plus `x-permdock-permissions`. `overlay({ version: '1.2' })` emits the pinned Overlay 1.2 draft. `target: '3.3'` emits the pinned Security Profile draft next to `x-permdock-securityProfile`. `scheme.type: 'gnap'` throws and emits nothing. CLI: `permdock openapi emit --doc openapi.json`; add `--arity` when a generated MCP server or SDK needs `x-permdock-arity` (instance or collection, and the id path parameter).

In a contract package that must not import the policy, use `securityFor(permission, { scheme?, anyOf? })` and `permissionsExtension(permissions)` from `permdock/openapi`: they take permission references only and return the same `security` and `x-permdock-permissions` as the server's `openapi.security(permission)`. They never mark a permission public and omit `x-permdock-conditions` and `x-permdock-approval`; those need the policy.

## React Native — `permdock/react-native`

No factory. Same hooks and `<Protected>` as `permdock/react`, plus `storage` so Expo Router `Stack.Protected` can answer on the first frame:

```ts
import { PermDockProvider, usePermission } from "permdock/react-native";
```

`storage` is `{ getItem, setItem, removeItem }` (MMKV, SecureStore, AsyncStorage). `snapshotUrl` revalidates in the background. `permdock.clear()` drops the persisted snapshot on sign-out. Do not import `policy.ts` on the client.

To answer guards from synced rows, write `localSnapshotManifest(policy)` (from `permdock`) to a JSON file at build time and pass `source={localSnapshot({ manifest, read, subscribe })}`. `read()` returns `{ principal: { id, tenant, roles, memberships, attributes }, customRoles }` from the local database; `subscribe` re-reads on row changes. It decides like the server snapshot except relation grantees (server-only) and the assignable lists (empty). Never import `policy.ts` into the app for this. Docs: [local snapshot](https://permdock.com/docs/adapters/react-native#local-snapshot).

For an offline app on PowerSync, set `powersync: { out: 'sync-config.yaml' }` in `permdock.config.ts` and run `permdock powersync generate`: one edition 3 Sync Stream per resource, from the `rls.tables` and `rls.memberships` the RLS generator reads. It under-syncs, never over-syncs: a resource with a deny grant gets no stream, and a grant with a global role, approval, break-glass, validity, request context or a condition without a Sync Streams form syncs nothing, each with a warning. The app reads what does not sync from the server. `permdock powersync verify --db $DATABASE_URL` fails when a stream holds a fixture row the policy denies; doctor PD058 flags a stale file. Docs: [`permdock powersync`](https://permdock.com/docs/cli/powersync).

## Express — `permdock/express`

```ts
import { createPermDock } from "permdock/express";

export const { permdock, protect, errorHandler } = createPermDock(policy, {
  subject: (req) => req.user ?? null,
});

app.use(permdock());
app.delete(
  "/posts/:id",
  protect(permissions.post.delete, (req) => loadPost(req.params.id)),
  handler,
);
app.use(errorHandler());
```

Converts `IncomingMessage` to Fetch, then delegates to `permdock/server`. Denials are `403 application/problem+json`; anonymous callers get `401` plus `WWW-Authenticate`.

## Fastify — `permdock/fastify`

```ts
import { createPermDock } from "permdock/fastify";

export const { permdock, protect } = createPermDock(policy, {
  subject: (request) => request.user ?? null,
});

await app.register(permdock);
app.delete(
  "/posts/:id",
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
import { createPermDock } from "permdock/elysia";

export const { permdock, protect } = createPermDock(policy, {
  subject: ({ store }) => store.user ?? null,
});

const app = new Elysia().use(permdock()).delete("/posts/:id", handler, {
  beforeHandle: protect(permissions.post.delete, ({ params }) =>
    loadPost(params.id),
  ),
});
```

Fetch-native plugin via `derive`. Denials are `403 application/problem+json`; anonymous callers get `401` plus `WWW-Authenticate`. For `.ws` routes, `connection(ws, { permission })` in `open` returns the socket's connection (memoised); it closes the socket with `1008` when revoked.

## Nest — `permdock/nest`

```ts
import { createPermDock } from "permdock/nest";

export const { PermDockModule, PermDockGuard, Protect, InjectPermDock } =
  createPermDock(policy, {
    subject: (request) => request.user ?? null,
  });
```

Register `PermDockGuard` as `APP_GUARD` with `useExisting`. `Protect` attaches a permission (and optional loader) to a handler or class. Denials are `403 application/problem+json`; anonymous callers get `401` plus `WWW-Authenticate`. Works on `@nestjs/platform-express` and `@nestjs/platform-fastify`. `permdockHandler({ path: ':org/permdock' })` mounts the decision controller where you choose. In a gateway, call `connection(client, client.request, { permission })` in `handleConnection` and `.close()` in `handleDisconnect`; `PermDockGuard` then checks each `@SubscribeMessage` through it.

## Node — `permdock/node`

```ts
import { createPermDock } from "permdock/node";

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
import { createPermDock } from "permdock/trpc";

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
import { createPermDock } from "permdock/orpc";

export const { permdock, protect, permdockHandler } = createPermDock(policy, {
  subject: ({ context }) => context.user ?? null,
});

const base = os.$context<Context>().use(permdock());
base
  .input(z.object({ id: z.string() }))
  .use(protect(permissions.post.delete, ({ input }) => loadPost(input.id)))
  .handler(({ context }) => deletePost(context.permdockData));
```

`protect` throws `ORPCError` (`FORBIDDEN`, `BAD_REQUEST`, `UNAUTHORIZED`) with Problem Details as `data`, and so does `context.permdock.assert` in a handler. Read the tenant from each procedure's input. `openapi.protect` is the same guard; pass `openapi.security(permission)` to oRPC 2's `openapi({ spec })` metadata helper. Event iterators behind `protect(permission, load, { items })` end and filter like tRPC subscriptions. `protect` also attaches to `implement(contract)` procedures, including ones with a declared `output`. Declare `oc.errors({ FORBIDDEN: { status: 403, data: problemDetails } })` with `problemDetails` from `permdock/openapi` and `protect` throws through that constructor: clients get a defined error with `data: ProblemDetails`, and the generated OpenAPI documents the 403 body.

## Vue — `permdock/vue`

```ts
import { permdockPlugin, Protected, usePermission } from "permdock/vue";

createApp(App).use(permdockPlugin, { snapshot, endpoint: "/api/permdock" });
```

Composables return refs (`allowed`, `status`, `decision`). Do not import `policy.ts` on the client.

## Svelte — `permdock/svelte`

```ts
import { setPermDock, permission, Protected } from "permdock/svelte";

setPermDock({ snapshot, endpoint: "/api/permdock" });
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

## OpenTelemetry — `permdock/otel`

```ts
import { instrument } from "permdock/otel";

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
} from "permdock/scim";

const directory = memoryDirectoryStore();
export const scim = scimHandler({
  store: directory,
  tenant: (request) => tenantFromPath(request),
  token: { hash: "sha256", lookup: (tenant) => hashFor(tenant) },
});
```

The handler writes users and groups. It never decides. Unknown or non-assignable role names are stored and dropped when memberships are read. Pass the app's `revocations` feed so a deprovisioned member's open streams revalidate and close.

## Cloud — `permdock/cloud`

No factory for a `PermDock`. `cloud({ url, key, environment })` returns `approvals`, `sink`, `snapshots` and `policies` to pass into any adapter, plus the environment `issuer` (`<url>/v1/environments/<environment>`) and its `jwks` URL; `cloudEndpoints({ url, environment })` computes the same two without a key. It never implements `MembershipSource` or `RoleSource` and never decides.

```ts
import { cloud } from "permdock/cloud";

const permdockCloud = cloud({
  url: process.env.PERMDOCK_CLOUD_URL,
  key: process.env.PERMDOCK_CLOUD_KEY,
});

export const { getPermDock } = createPermDock(policy, {
  subject,
  store: permdockCloud.approvals,
  sink: permdockCloud.sink,
  snapshots: permdockCloud.snapshots,
});
```

Hosted grants are opt-in per permission. List the permissions a Cloud admin may grant in `definePolicy(..., { hostable: [permissions.auditLog.read] })`, pass `verifier: joseTokenVerifier({ jwks: cloudEndpoints({ url, environment }).jwks })` to `cloud()` (the policy document's issuer and audience are both the environment URL), forward `policies: permdockCloud.policies`, and call `permdockCloud.policies.refresh()` on a timer. Never mark a permission `hostable` when `permdock rls` compiles its table (`permdock doctor` PD020).

`PERMDOCK_CLOUD_URL` and `PERMDOCK_CLOUD_KEY` are server-only. Production `PERMDOCK_CLOUD_URL` is `https://api.permdock.com`. The dashboard is `https://app.permdock.com`; the read-only MCP server is `https://mcp.permdock.com`. A Cloud outage leaves directory memberships at their last synced state.

## Better Auth — `permdock/better-auth`

```ts
import {
  subjectFromBetterAuth,
  betterAuthRoleSource,
} from "permdock/better-auth";

const session = await auth.api.getSession({ headers });
const subject = await subjectFromBetterAuth(auth, session);
const permdock = await createPermDock(policy, subject, {
  customRoles: betterAuthRoleSource(auth),
});
```

Pass the server `getSession` result only. A null session is anonymous. Never call `hasPermission` on the request path.

## Clerk — `permdock/clerk`

```ts
import { subjectFromClerk } from "permdock/clerk";

export const { getPermDock } = createPermDock(policy, {
  subject: async () => subjectFromClerk(await auth()),
});
```

Pass `auth()` or a verified session payload only. A plain `{ userId }` object is anonymous. `memberships: 'all'` loads organizations through the Clerk Backend API. `o:` plans and features from `pla` and `fea` hold only in the session organization.

## Supabase — `permdock/supabase`

```ts
import { subjectFromSupabase, authorizeSql } from "permdock/supabase";

const subject = subjectFromSupabase(claims, {
  roles: "user_role",
  tenant: "tenant_id",
  memberships: "memberships",
  declared: ["member", "admin"],
});
```

Write the claims with `permdock supabase hook generate`; `permdock supabase inspect --json` prints the manifest (helper names, tenant claim, budget, claims written) a package such as better-supabase reads before it writes Storage or Realtime policies against the helpers. No `@supabase/supabase-js` peer. Pair with `permdock rls generate`, or keep SQL as authority and run `permdock rls verify --db` against `sqlFunction` twins ([database-first](https://permdock.com/docs/adapters/rls)); the generic RLS workflow is in the `permdock-data` skill.

With better-supabase, map its session with `subjectFromSupabaseSession(session, { plans: 'features' })`: the active tenant's `features` become `principal.plans`. Validate its claims with `betterSupabase.claims(supabaseClaims().extend(appSchema))` (`supabaseClaims` from `permdock/supabase`, any Standard Schema as `appSchema`) instead of a hand-written copy of the claim shape. A `supabase.hook.claims` function that needs the user's organizations calls `<schema>.member_organization_ids_for(user_id)` (generated by `rls generate`, executable by `supabase_auth_admin` only) instead of querying the membership tables itself. A token Supabase's OAuth server issued to a third-party app (`client_id`) becomes an `oauth-client` actor limited to its `scope`; `deny(permission, { to: actor('oauth-client') })` keeps such apps out, in the app and, through `rls generate`, in Postgres. A better-supabase support session (`act.kind: 'support'`) is actor kind `support` with `sessionId` and `readOnly`, and `actingAs` (`act.kind: 'impersonation'`) is kind `impersonation`; neither has a delegation, so they reach nothing until a policy delegation names `actor('support')` or `actor('impersonation')`, and `readOnly: true` narrows that to read-only permissions. With `rls.anonymousSignIns: 'deny'`, pass `anonymousSignIns: 'deny'` to the subject mapper too (doctor PD057). Check a deployed database against the generated policies with `permdock rls verify --introspect --db $DATABASE_URL`.

`claims` is whatever Supabase verified: `data.claims` from `supabase.auth.getClaims()` on an `@supabase/ssr` server client, or `jwtClaims` from `@supabase/server` (`ctx.jwtClaims` in `withSupabase`, `c.var.supabaseContext.jwtClaims` in its Hono adapter). Pass `null` for anonymous callers; never `getSession().access_token` (unverified). An API-key auth mode (`secret`, `publishable`) has `jwtClaims: null` and is the anonymous subject, not a user.

Share links reach RLS through `exchangeCapability`; see the `permdock-credentials` skill.

Supabase specifics for generated RLS (the generic flags and parity checks are in the `permdock-data` skill):

- With declarative schemas on pg-delta (`[experimental.pgdelta] enabled = true`), run `permdock rls generate --target sql --split helpers,seeds,indexes,policies,hook --seeds-out supabase/migrations/<timestamp>_permdock_seeds.sql` with no `--out`: it writes `supabase/schemas/permdock/{helpers,indexes}.sql`, `public/policies/permdock.sql` and `permdock/functions/custom_access_token_hook.sql`, grants included. Then `supabase db schema declarative sync -f <name>` writes the migration; the seeds migration must sort after it. Never put the `role_permissions` rows in a schema file: pg-delta rejects data.
- With `supabase db diff` instead, generate `--split helpers,seeds,policies,hook --out supabase/schemas/identity/056_permdock_{part}.sql` and write the hook's `supabase_auth_admin` grants with `--grants-out` into a migration created by `supabase migration new` after the first `db diff`; `db diff` drops those grants. Keep the helpers part ahead of every file that calls the helpers in `schema_paths` (`permdock doctor` PD042, PD043).
- `--authorize jwt` reads the hook's claims: enable the printed `[auth.hook.custom_access_token]` stanza in `supabase/config.toml`. The generated hook writes the canonical `memberships` claim from the `rls.memberships.scopes` tables, so do not hand-write one.
- For more than one membership table, declare `fromTable` / `fromJunction` sources once (from `permdock/supabase`, with a `query` on the server), pass the array as `memberships` (wrapped in `claimsFirst(sources, { version: authzVersion({ query }) })` to trust the token until it is truncated or stale), put the same sources under `supabase.hook.memberships` in `permdock.config.ts`, and run `permdock supabase hook generate`; add the printed `config.toml` block (`jwt_expiry = 900`). List member-removal and payout permissions in `definePolicy({ fresh })`.
- When a role table stores a role id (`user_roles.role_id`, `organization_users.role_id` referencing `roles`), read the key through it with `{ through: 'roles', on: { role_id: 'id' }, column: 'key' }`: in `rls.roles`, in `fromTable` `columns.role` or `fromJunction` `roles`, and in an `rls.memberships` table's `role`. Never copy keys into the membership table. Keep tenant custom-role keys apart from declared role names.
- When one membership row holds roles in several columns (a `tier` and a `role_id`), list them instead of building a union view: `role: ['tier', { through: 'roles', on: { role_id: 'id' }, column: 'key' }]` in `rls.memberships` and `fromTable` `columns.role`, `roles: { sources: [...] }` in `fromJunction`. The row holds every non-null key, and the holder-count triggers stay on the real table.
- For attribute conditions (`principal.claims.attrs.region`), list server-owned columns or `app_metadata.<key>` in `supabase.hook.attrs`, never `user_metadata`, and keep clients from updating those columns (`permdock doctor` PD028).

## Supabase middleware pipeline — `permdock/supabase/middleware`

```ts
import { pipeline } from "@supabase/middleware";
import { withClaims } from "@supabase/server/middleware/claims";
import { subjectFromSupabase } from "permdock/supabase";
import { createPermDock } from "permdock/supabase/middleware";

const { withPermDock, permdockHandler } = createPermDock(policy, {
  subject: (ctx) =>
    subjectFromSupabase(ctx.jwtClaims, {
      roles: "user_role",
      declared: ["member", "admin"],
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
import { createPermDock, remotePdp } from "permdock/pdp";

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

Nuxt, Astro, React Router, TanStack Start and Effect have no `permdock/<name>` entry. Add `createPermDockUnplugin.vite()` from `permdock/unplugin` (or `.webpack` / `.esbuild`). Runtime is `permdock/server` or the matching HTTP adapter, plus `permdock/vue`, `permdock/react` or `permdock/svelte` on the client. Effect Schema is a Standard Schema; Effect HttpApi uses Overlay, not a hook.

Remaining work follows the names on the adapter page under `/docs/adapters/<name>`. Do not invent identifiers.
