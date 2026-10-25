---
"permdock": minor
---

`rls generate --helpers-only` with `rls.readOnlyActors` now writes the restrictive `{table}_{op}_read_only_actors` policies for each table `rls.tables` names, in the output or the `helpers` part, each skipped when its table does not exist. This changes helpers-only output: regenerate, and drop any hand-written restrictive policy that only calls `permdock_actor_may_write()` on those tables. A resource without an `rls.tables` entry still gets the warning.
