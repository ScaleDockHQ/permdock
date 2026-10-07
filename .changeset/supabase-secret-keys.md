---
"permdock": minor
---

`createPermDock({ secretKeys })` in `permdock/supabase/middleware` turns a Supabase secret key that `withSupabase` matched by name into a tenant `service` principal capped at the declared permissions, and `withSubject` now writes the `rls.apiKeys` claim (`sub: ''` for a service key) for any principal that acts through a credential. `fromSupabasePostgres(ctx.postgres)` in `permdock/supabase` adapts `withPostgresClient`'s client to the `SqlQuery` that `fromTable`, `fromJunction` and `supabaseApprovalStore` take.
