---
"permdock": minor
---

With `rls.readOnlyActors`, `rls generate` now writes `permdock_actor_may_write()`, which is false for a read-only support or impersonation token, so hand-written write policies in `--helpers-only` mode can call it. `rls verify --introspect --helpers-only` reports each insert, update or delete that `authenticated` reaches without calling it. The Supabase manifest lists the function in `rls.helpers`.
