---
"permdock": patch
---

With `rls.readOnlyActors`, the `approval_delegations` insert, update and delete policies that `rls.approvals.delegations` generates now call `permdock_actor_may_write()`, so a read-only support or impersonation session can no longer write covers as the user. Run `permdock rls generate` and migrate. `rls verify --introspect` also accepts the restrictive `<table>_<command>_read_only_actors` policies `rls generate` writes, instead of reporting them as `write-unguarded`.
