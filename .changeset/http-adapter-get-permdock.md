---
"permdock": minor
---

`permdock/hono`, `express`, `fastify`, `elysia` and `nest` return `getPermDock(request)`, and `permdock/trpc` and `orpc` return `getPermDock(opts)`: the `PermDock` for one request outside the middleware, as on `permdock/server` and `permdock/node`.
