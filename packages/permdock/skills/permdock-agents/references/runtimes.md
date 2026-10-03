# Agent runtimes

Every agent adapter exports `createPermDock` from `permdock/<runtime>` and takes `subject`, `actor`, `delegation`, `tools` and `store`. One permission per tool. Instance actions load the row through `data`; tool input arrives as `unknown`, so parse it before loading. The current adapter page is `https://permdock.dev/docs/adapters/<name>`.

## AI SDK — `permdock/ai-sdk`

```ts
import { createPermDock } from "permdock/ai-sdk";
import { z } from "zod";

const PostArgs = z.object({ id: z.string() });

export const { toolApproval, capabilityMiddleware, needsApproval } =
  createPermDock(policy, {
    subject: ({ runtimeContext }) => runtimeContext.user,
    actor: ({ runtimeContext }) => ({
      id: runtimeContext.agentId,
      kind: "ai-sdk",
    }),
    delegation: () => ({ scopes: [permissions.post.delete.scope] }),
    tools: {
      delete_post: {
        permission: permissions.post.delete,
        data: (args) => loadPost(PostArgs.parse(args).id),
      },
    },
  });
```

Pass `toolApproval` into `generateText` / `ToolLoopAgent`. Wrap the model with `wrapLanguageModel({ model, middleware: capabilityMiddleware({ user }) })` per caller. Use `needsApproval(permissions.post.delete)` only on `WorkflowAgent`. `denied` maps to `'denied'`, `approval-required` to `'user-approval'`, and `'not-applicable'` is never returned ([AI SDK adapter](https://permdock.dev/docs/adapters/ai-sdk)).

## Claude Agent SDK — `permdock/claude-agent`

```ts
import { createPermDock } from "permdock/claude-agent";

export const { canUseTool, permissionRequestHook } = createPermDock(policy, {
  subject: () => user,
  actor: () => ({ id: "claude", kind: "claude-agent" }),
  delegation: () => ({ scopes: [permissions.post.delete.scope] }),
  tools: {
    delete_post: {
      permission: permissions.post.delete,
      data: (args) => loadPost(args),
    },
  },
});
```

`canUseTool` returns `{ behavior: 'allow', updatedInput }` or `{ behavior: 'deny', message }`; approval-required is a deny whose message carries the pending token. Pass a `store`: once a reviewer approves, the retried call is allowed exactly once. `mcp__` tools are trusted only from `mcpSources` (default `['sdk']`). Pass `permissionRequestHook` under `hooks.PermissionRequest` ([Claude Agent adapter](https://permdock.dev/docs/adapters/claude-agent)).

## Eve — `permdock/eve`

```ts
import { createPermDock } from "permdock/eve";

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

Pass `approval` as the tool's `approval`. Default subject and actor read `session.auth.initiator` / `current`. `approval.request(ctx)` maps granted to Eve's `not-applicable` (continue), approval-required to `user-approval`, denied to `{ type: 'denied', reason }`; Eve's re-check of a call nobody approved is denied. `approval.response(ctx)` maps the responder through the same `subject`. Use a durable `store` when replicas share sessions ([Eve adapter](https://permdock.dev/docs/adapters/eve)).

## OpenAI Agents SDK — `permdock/openai`

```ts
import { createPermDock } from "permdock/openai";

export const { needsApproval, guardTools, resolveInterruptions, permdock } =
  createPermDock(policy, {
    subject: (ctx) => ctx.user,
    actor: (ctx) => ({ id: ctx.agentId, kind: "openai" }),
    delegation: (ctx) => ({ scopes: ctx.scopes }),
    tools: {
      delete_post: {
        permission: permissions.post.delete,
        data: (args) => loadPost(args),
      },
    },
  });
```

`needsApproval(permission)` is the tool's `needsApproval`; it reads `runContext.context` and is true unless granted. `guardTools` drops tools with no grant. `resolveInterruptions(state, interruptions, { context })` approves or rejects each pause and returns the still-pending `ApprovalRequest`s. On resume, rebuild the context from the session and use `RunState.fromStringWithContext` ([OpenAI adapter](https://permdock.dev/docs/adapters/openai)).

## MCP — `permdock/mcp`

```ts
import { createPermDock } from "permdock/mcp";

export const { protectServer } = createPermDock(policy, {
  subject: (authInfo) => userFrom(authInfo), // or subjectFromMcp
  requireAuthInfo: true, // HTTP behind bearer auth
  store,
});

const server = protectServer(
  new McpServer({ name: "posts", version: "1.0.0" }),
);
server.registerTool(
  "delete_post",
  {
    permission: permissions.post.delete,
    inputSchema: z.object({ id: z.string() }),
    data: ({ id }) => loadPost(id),
  },
  handler,
);
```

`actor.kind` is `'mcp-client'`, and `delegation` comes from the token's scopes and `authorization_details`. Every `registerTool` / `registerResource` / `registerPrompt` needs a `permission`. Lists are filtered per caller. A missing scope is an `insufficient_scope` step-up (HTTP `403`) naming only the scope the call needs. Set `resource` to the server's URL so tokens for another audience are refused. Denied calls return `isError: true` with Decision `structuredContent`. `approval-required` parks the call in `store` and returns `isError: true` with the token, or an `input_required` URL request when `approval.at` is set and the client declares URL elicitation; the retried call runs once after approval (token optional under `_meta["dev.permdock/approval"]`, never from tool arguments) ([MCP adapter](https://permdock.dev/docs/adapters/mcp)).

An MCP server that is not an SDK `McpServer` cannot be wrapped: narrow the tool's `meta` with `isPermission`, filter its tool list with `mayUse(permdock, permission)` from `permdock`, and decide each call with `permdock.decide(permission, args)` in its `authorize` hook. `mayUse` is a listing hint, never a decision.

## A2A — `permdock/a2a`

```ts
import { createPermDock } from "permdock/a2a";

export const { agentCard, extendedAgentCard, protectSkill } = createPermDock(
  policy,
  {
    subject: (auth) => userFrom(auth),
    card: {
      name: "Posts agent",
      url: "https://agent.example.com/a2a",
      version: "1.0.0",
    },
    securitySchemes: { oauth: { type: "oauth2" } },
    skills: {
      summarise: { permission: permissions.post.read },
      publish: {
        permission: permissions.post.publish,
        data: (task) => loadPost(task.postId),
      },
    },
  },
);

app.get("/.well-known/agent-card.json", (c) => c.json(agentCard()));
app.get("/a2a/extended-card", (c) => c.json(extendedAgentCard(c.get("auth"))));
app.post(
  "/a2a/tasks",
  protectSkill((task) => task.skillId),
  handleTask,
);
```

Identity comes from transport auth, never the task body. `actor.kind` is `'a2a'`, with `delegation` from the caller's token. Each skill's `securityRequirements` name the permission's `scope`. The public card is never filtered; `extendedAgentCard(auth)` keeps only skills the caller has a grant for. An instance-level skill without `data` throws at startup ([A2A adapter](https://permdock.dev/docs/adapters/a2a)).

## WebMCP — `permdock/webmcp`

Client entry. No factory. Register snapshot-allowed tools on `document.modelContext`:

```ts
import { registerTools } from "permdock/webmcp";
import { approvalHeaders, usePermDock } from "permdock/react";

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

Never import a policy into this entry. A missing `document.modelContext` is a no-op. Tools re-register when the snapshot changes. The client check is a filter: the server adapter behind `api.posts` makes the decision. `onApprovalRequired` opens the page's own confirmation dialog ([WebMCP adapter](https://permdock.dev/docs/adapters/webmcp)).

## Web Bot Auth on HTTP adapters

```ts
import {
  createPermDock,
  discoverViaSignatureAgent,
  verifyWebBotAuth,
} from "permdock/hono";

const keys = discoverViaSignatureAgent({ allow: ["agents.example.com"] });

export const { permdock, protect } = createPermDock(policy, {
  subject: (c) => c.get("user"),
  webBotAuth: (request) => verifyWebBotAuth(request, { verify: true, keys }),
});
```

A verified RFC 9421 signer becomes the actor with `kind: 'web-bot-auth'`; `delegation` comes from a bearer token on the same request, otherwise it is empty. A failed signature throws `InvalidSignatureError`, never an anonymous actor ([Web Bot Auth](https://permdock.dev/docs/standards/web-bot-auth)).

## Terminal — `permdock/terminal`

```ts
import { createPermDock } from "permdock/terminal";

export const { permdock, protect, filterCommands, format, exitCode } =
  createPermDock(policy, {
    subject: async ({ token }) => {
      const jwt = await token(["env", "keychain", "ci-oidc", "device"]);
      return jwt ? subjectFromJwt(jwt, { issuer, audience: "acme-cli" }) : null;
    },
  });
```

For the app's own CLI; not the `permdock` binary. Never accept `--user` or `--actor` as identity. In CI, verify the job token with `subjectFromCiOidc(jwt, { provider: 'github', audience })` from `permdock/jwt`, which returns a `workload` principal, never a user. A `destructive` permission asks for the resource id to be typed, and exits `64` without a terminal unless `--yes` is passed; `--yes` never approves an `approval-required` call. `--dry-run` decides and exits with the outcome's code without running the action ([terminal adapter](https://permdock.dev/docs/adapters/terminal)).
