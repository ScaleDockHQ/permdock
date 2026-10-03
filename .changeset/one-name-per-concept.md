---
"permdock": patch
---

One name per concept, and the policy vocabulary reaches every handler.

Adapters that hand out an instance now type it with the policy's roles, plans and permissions (`PermDock<V>`), as core and `permdock/next` already did: Hono's `c.get('permdock')`, Express and Fastify `withPermDock` handlers, Elysia's derived `permdock`, the Node, Claude Agent SDK, Eve, OpenAI Agents and terminal `permdock()` results, the terminal `protect` context, the Supabase middleware contribution, oRPC middleware context, Convex `ctx.permdock` and `PdpPermDock`. `permdock/fastify` gains `withPermDock(handler)`, which types `request.permdock` without augmenting `FastifyRequest`.

| Old                                                                   | New                                               |
| --------------------------------------------------------------------- | ------------------------------------------------- |
| `CreatePermDockOptions`                                               | `PermDockOptions`                                 |
| `CreatePermDockPluginOptions`                                         | `PermDockPluginOptions`                           |
| `ServerPermDock.handler`, `AuthzenPermDock.handler`                   | `permdockHandler`                                 |
| `ExpressPermDock.handler(fn)`                                         | `withPermDock(fn)`                                |
| `SsfAdapter`, `SsfOptions`                                            | `SsfPermDock`, `SsfPermDockOptions`               |
| `SupabaseMiddlewareOptions`                                           | `SupabaseMiddlewarePermDockOptions`               |
| `A2AAgentCard`, `A2APermDock` and the other `A2A*` types              | `A2aAgentCard`, `A2aPermDock`, …                  |
| `dock`, `pd`, `server`, `factory` for the instance in docs and skills | `permdock`; a `cloud()` result is `permdockCloud` |
