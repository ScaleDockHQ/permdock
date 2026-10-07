---
"permdock": patch
---

The `permdock-wire` skill now wires `@supabase/server` into Hono, H3, Elysia and NestJS through a pipeline bridge (`toHono([withClaims(), withPermDock()])`, then `c.var.permdock`) instead of the deprecated `@supabase/server/adapters/*`, which are removed on 1 December 2026.
