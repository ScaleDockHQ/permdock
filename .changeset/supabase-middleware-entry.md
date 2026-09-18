---
'permdock': minor
---

Add `permdock/supabase/middleware`: `createPermDock(policy, { subject, … })` returns `withPermDock`, `permdockHandler` and `openapi` for the `@supabase/middleware` pipeline. `withPermDock()` requires an upstream `jwtClaims` contribution (`withClaims` from `@supabase/server`) and contributes a request-scoped `ctx.permdock`; `withPermDock({ protect, data })` short-circuits denials with RFC 9457 Problem Details and honours the `PermDock-Approval` resume header. `@supabase/middleware` is an optional peer of this entry only; `permdock/supabase` stays peer-free and `@supabase/server`'s `JWTClaims` is typed structurally as `SupabaseJwtClaims`. Ships with `apps/examples/supabase-middleware` (real ES256 verification through `withClaims` against an in-process JWKS) and recipes for `@supabase/server` (`withSupabase`, `withPostgresClient`, `withOAuthProtectedResource`) and `@supabase/ssr` on the Supabase, MCP and RLS adapter pages (ADR 0046).
