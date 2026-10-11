# Adapter setup

Each adapter wraps the same `betterSupabase` from `src/lib/supabase/index.ts`:

```ts title="src/lib/supabase/index.ts"
import { defineSupabase } from "better-supabase";

import { schema } from "./generated";

export type { Functions, Models } from "./generated";

export const betterSupabase = defineSupabase(schema);
```

## Next.js

```ts title="src/lib/supabase/server.ts"
import "server-only";
import { createNext } from "better-supabase/next";

import { betterSupabase } from "./index";

export const bs = createNext(betterSupabase);
```

```ts title="src/proxy.ts"
import type { NextRequest } from "next/server";

import { bs } from "./lib/supabase/server";

export const proxy = (request: NextRequest) => bs.proxy(request);
```

The proxy is the only place that refreshes sessions. Server Components,
route handlers and actions read the verified token:

```ts
const { db } = await bs.context();
export const GET = bs.route(
  (request, { db }) => db.customers.findMany({ limit: 20 }),
  { scopes: ["customers:read"] }, // only limits OAuth clients and agents
);
```

## Hono

```ts title="src/server.ts"
import { createHono } from "better-supabase/hono";

import { betterSupabase } from "./lib/supabase";

const bs = createHono(betterSupabase);

// bs.app() is new Hono<typeof bs.Env>() with bs.onError installed.
const app = bs
  .app()
  .use("/api/*", bs.middleware())
  .get("/api/me", (c) => c.json({ kind: c.var.auth.kind }))
  .route(
    "/api/customers",
    bs.resource("customers", { select: ["id", "name"] }),
  );

export default app;
```

## oRPC

```ts title="src/router.ts"
import { os } from "@orpc/server";
import { createOrpc, type OrpcRequestContext } from "better-supabase/orpc";

import { betterSupabase } from "./lib/supabase";

export const bs = createOrpc(betterSupabase);
const authed = os.$context<OrpcRequestContext>().use(bs.middleware());

export const router = {
  customers: authed.handler(({ context }) =>
    bs.unwrap(context.db.customers.findMany({ limit: 20 })),
  ),
};
```

For a contract from `@orpc/contract`, use the same middleware on the
implementer and serve it with `OpenAPIHandler`, so errors keep their HTTP
status (RLS denials answer 403):

```ts title="src/server.ts"
const os = implement(contract)
  .$context<OrpcRequestContext>()
  .use(bs.middleware());
const router = os.router({
  customers: {
    get: os.customers.get.handler(({ context, input }) =>
      bs.unwrap(context.db.customers.findById(input.id)),
    ),
  },
});
const handle = bs.fetchHandler(new OpenAPIHandler(router), { prefix: "/api" });
const app = new Hono().all("/api/*", (c) => handle(c.req.raw));
```

## Edge Functions

```ts title="supabase/functions/api/index.ts"
import { createEdge } from "better-supabase/edge";

import { betterSupabase } from "../_shared/supabase.ts";

const bs = createEdge(betterSupabase, { cors: true });

Deno.serve(
  bs.resources({ customers: { select: ["id", "name"] } }, { basePath: "/api" }),
);
```

## Middleware entries and bridges

`withBetterSupabase(server, { allow })` from `better-supabase/server` is one
`@supabase/middleware` entry: it resolves the caller, guards, and contributes
`bs`, `db`, `sql`, `jwtClaims`, `userClaims` and `authMode`. Put
`withPostgresClient` or `withCors` next to it, then run the array with the
bridge for the framework:

```ts title="src/hooks.server.ts"
import { createServer, withBetterSupabase } from "better-supabase/server";
import { toSvelteKit } from "better-supabase/sveltekit";

import { betterSupabase } from "$lib/supabase";

export const handle = toSvelteKit([
  withBetterSupabase(createServer(betterSupabase), {
    refresh: true,
    allow: ["user", "anon"],
  }),
]);
```

| Framework           | Bridge                                             | Where the keys land                                 |
| ------------------- | -------------------------------------------------- | --------------------------------------------------- |
| Hono                | `toHono(entries)` from `better-supabase/hono`      | `c.var`                                             |
| Edge, Deno, Workers | `toEdge(entries, handler)` from `/edge`            | the handler's `ctx`                                 |
| oRPC                | `toOrpc(entries, rpcHandler)` from `/orpc`         | the initial `context`                               |
| Expo API routes     | `toExpo(entries, handler)` from `/expo`            | the handler's `ctx`                                 |
| TanStack Start      | `toTanStackStart(entries)` from `/tanstack-start`  | middleware `context`                                |
| SvelteKit           | `toSvelteKit(entries)` from `/sveltekit`           | `event.locals`                                      |
| React Router        | `toReactRouter(entries, key)` from `/react-router` | `context.get(key)`                                  |
| H3, Nitro, Nuxt     | `toH3(entries)` from `/h3`                         | `event.context`                                     |
| Elysia              | `toElysia(entries)` from `/elysia`                 | `.derive(({ request }) => bridge.context(request))` |
| Nitro 2, Nuxt       | `toH3V1(entries)` from `/h3/v1`                    | `event.context`                                     |
| Node `http`         | `toNodeHandler(entries, handler)` from `/node`     | the handler's `ctx`                                 |
| Express             | `toExpress(entries)` from `/node`                  | `res.locals`                                        |
| Fastify             | `toFastify(entries)` from `/node`                  | `request.locals`                                    |
| Koa                 | `toKoa(entries)` from `/node`                      | `ctx.state`                                         |
| NestJS              | `toNestMiddleware(entries)` from `/nestjs`         | `@Ctx("db")` in a controller                        |

Don't use the `@supabase/server/adapters/*` adapters: they are deprecated and
removed on 2026-12-01. Don't put `withSupabase` and `withBetterSupabase` in
one array; they write the same keys and the type checker rejects it. Set
`refresh: true` only on the bridge that runs once per request with a response
(request middleware, the `handle` hook), never in Server Components.

## Node, Express, Fastify and Koa

`better-supabase/node` types each framework structurally, so it adds no
dependency. Each bridge has a guard and an error handler that answers
`.orThrow()` failures with Problem Details:

```ts title="app.ts"
import express from "express";
import { guard, problemErrorHandler, toExpress } from "better-supabase/node";
import { withBetterSupabase } from "better-supabase/server";

import { bs } from "./lib/server";

const app = express();
app.use(
  toExpress([
    withBetterSupabase(bs, { refresh: true, allow: ["user", "anon"] }),
  ]),
);
app.get("/admin/members", guard({ roles: ["admin"] }), async (req, res) => {
  res.json(await res.locals.db.members.findMany().orThrow());
});
app.use(problemErrorHandler());
```

| Framework   | Bridge                              | Guard                                   | Errors                  |
| ----------- | ----------------------------------- | --------------------------------------- | ----------------------- |
| `node:http` | `toNodeHandler(entries, handler)`   | `allow` on `withBetterSupabase`         | the handler's `Result`  |
| Express     | `toExpress(entries)`                | `guard(options)` per route              | `problemErrorHandler()` |
| Fastify     | `toFastify(entries)` in `onRequest` | `fastifyGuard(options)` as `preHandler` | `problemErrorHandler()` |
| Koa         | `toKoa(entries)`                    | `koaGuard(options)`                     | built into `toKoa`      |

For Fastify, call `app.decorateRequest("locals", null)` first. Type
Express's `res.locals` by extending `Express.Locals` with
`BetterSupabaseContributions<Models, Functions, unknown>` from
`better-supabase/server`.

## NestJS

```ts title="src/app.module.ts"
consumer
  .apply(toNestMiddleware([withBetterSupabase(bs, { allow: ["user"] })]))
  .forRoutes("*");
```

```ts title="src/notes.controller.ts"
import { Controller, Get, UseFilters, UseGuards } from "@nestjs/common";
import { Ctx, guard, problemFilter } from "better-supabase/nestjs";

@Controller("notes")
@UseFilters(problemFilter())
export class NotesController {
  @Get()
  @UseGuards(guard({ roles: ["admin"] }))
  list(@Ctx("db") db: Db) {
    return db.notes.findMany({ select: ["id", "title"] }).orThrow();
  }
}
```

## Astro and SolidStart

```ts title="src/lib/server.ts"
import { createAstro } from "better-supabase/astro";

export const bs = createAstro(betterSupabase, { signIn: "/sign-in" });
// src/middleware.ts: export const onRequest = bs.onRequest;
```

In a page, `const refused = await bs.guard(Astro, { roles: ["admin"] })`
returns the refusal to send, and `bs.locals(Astro).db` is the caller's
`db`. Wrap an Action's handler with `bs.action({ input, requireTenant }, fn)`.
`createImageService({ url })` serves Storage images through Astro's image
service.

```ts title="src/lib/server.ts"
import { createSolidStart } from "better-supabase/solid-start";
import { getRequestEvent } from "solid-js/web";

export const bs = createSolidStart(betterSupabase, {
  getRequestEvent,
  signIn: "/sign-in",
});
// src/middleware.ts: export default createMiddleware(bs.middleware);
```

In a `"use server"` query, `const { db } = await bs.require()`; for forms,
`bs.action({ input }, (input, { db }) => ...)`.

## Nuxt and Nitro 2

Export the entries from `server/better-supabase.ts`, register the module
with `modules: ["better-supabase/nuxt"]` and
`betterSupabase: { server: "~~/server/better-supabase" }` in
`nuxt.config.ts`, or run them yourself with
`defineEventHandler(toH3V1(entries))` from `better-supabase/h3/v1`. Guard a
route with `(await guard({ roles: ["admin"] })(event)) ?? ...`, and turn
`.orThrow()` failures into Problem Details with `problemOnError()`. On H3 2
and Nitro 3, use the same helpers from `better-supabase/h3`.

## MCP

```ts title="supabase/functions/mcp/index.ts"
import { createMcp } from "better-supabase/mcp";
import { toSession } from "better-supabase/server";

import { betterSupabase } from "../_shared/supabase.ts";

const bs = createMcp(betterSupabase, {
  name: "crm",
  version: "0.1.0",
  advertisedScopes: ["openid", "crm.read"],
  allowedOrigins: ["https://claude.ai"],
  allowedHosts: ["crm.example.com", "localhost"],
  resourceDocumentation: "https://crm.example.com/docs/mcp",
  resources: {
    customers: { select: ["id", "name"], pagination: "cursor" },
  },
  authorize: (ctx) => {
    const session = toSession(ctx.auth);
    const granted =
      session.kind === "user" ? session.delegation?.scopes : undefined;
    return !granted || granted.includes("crm.read")
      ? { allowed: true }
      : { allowed: false, reason: "Needs crm.read", scopes: ["crm.read"] };
  },
});

Deno.serve(bs.fetch);
```

Tools run as the calling user, so RLS applies to every tool call.
`advertisedScopes` only advertises scopes; `requiredScopes` refuses delegated
tokens that lack one, and `authorize` refuses a single call. The session comes
from the `Authorization` header only, never from a cookie. A
`delegation` that is unset means the user's own token, which no scope limits.

On Supabase Edge Functions, set `[functions.mcp] verify_jwt = false` in
`supabase/config.toml`; the gateway's own 401 has no OAuth challenge. The
server then derives its public URL from `SUPABASE_FUNCTION_SLUG` and the
gateway's `X-Forwarded-*` headers and serves the metadata at
`/functions/v1/mcp/oauth-protected-resource`, so leave `resource` unset there.
CORS preflights are answered by default (`cors: false` turns them off).
To keep a Supabase library MCP block's pipeline instead, add
`withBetterDb(betterSupabase)()` from `better-supabase/server` after its
`withSupabase` entry for `ctx.db`.

### MCP on the official SDK

```ts title="src/mcp.ts"
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { createMcpAuth, withBetterSupabaseMcp } from "better-supabase/mcp/sdk";

import { betterSupabase } from "./lib/supabase/schema";

const auth = createMcpAuth(betterSupabase, {
  resource: "https://crm.example.com/mcp",
  advertisedScopes: ["crm.read"],
});

const handler = createMcpHandler(() => {
  const server = withBetterSupabaseMcp(
    new McpServer({ name: "crm", version: "0.1.0" }),
    auth,
  );
  server.registerTool("count_customers", {}, async ({ db }) => {
    const count = await db.customers.count().orThrow();
    return { content: [{ type: "text", text: String(count) }] };
  });
  return server;
});

export default { fetch: auth.serve(handler) };
```

`auth.serve` answers the RFC 9728 metadata and the 401 challenge, then passes
the verified `authInfo` to the SDK handler. `auth.verifier` plugs into the
SDK's own `requireBearerAuth` when you keep your own routing.
