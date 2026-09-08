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
import { createPermDock } from 'permdock/hono';

export const { permdock, protect, permdockHandler } = createPermDock(policy, {
  subject: (c) => c.get('user'),
});

app.use('*', permdock());
app.delete(
  '/posts/:id',
  protect(permissions.post.delete, (c) => loadPost(c)),
  handler,
);
```

## React (Vite) — `permdock/react`

No factory. The server builds a snapshot (`permdock.snapshot()` or `fromSnapshot` on a Snapshot v2 JSON) and the client wraps the tree:

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

## Planned adapters

tRPC, oRPC, Vue, Svelte and Solid follow the same factory name from `permdock/<framework>`. Read the adapter page under `/docs/adapters/<name>` before inventing identifiers.
