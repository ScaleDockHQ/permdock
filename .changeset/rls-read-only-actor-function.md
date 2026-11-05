---
"permdock": minor
---

**Breaking:** `permdock rls generate` writes each `*_read_only_actors` policy as `(select permdock_actor_may_write())` instead of inlining the `act` expression; regenerate and apply the output. `permdock doctor` PD090 also reads `supabase/schemas` and `rls.out` and flags a hand-written policy that inlines the 0.24 guard.
