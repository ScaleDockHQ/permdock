---
"permdock": minor
---

With `rls.readOnlyActors` and `--helpers-only`, `rls generate` writes a read-only actor guard for every table whose `supabase/schemas` files let `authenticated` write, into `permdock/read_only_actors.sql` under pg-delta. `rls verify` counts `better_supabase.actor_may_write()` as a guard.
