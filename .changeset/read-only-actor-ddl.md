---
"permdock": minor
---

`permdock rls generate --helpers-only` writes the `rls.readOnlyActors` policies as plain `create policy` statements instead of `to_regclass` guarded `do` blocks, so apply the helpers after the migrations that create the tables. Doctor `PD090` flags a hand-written policy that repeats the generated `permdock_actor_may_write()` guard.
