---
"permdock": minor
---

Catalog permissions carry `rowConditions` when `permdock.config.ts` names a policy: `true` when a code grant for the key has a `where`, `check`, closure, field list, purpose, break-glass override, or a relation, plan, actor or assurance grantee, which the SQL helpers (`permdock_has`, `permitted_<scope>_ids`) do not check. `permdock doctor` PD037 errors on a migration's `storage.objects` or `realtime.messages` policy that calls a helper for such a key, and `permdock rls verify --db` reports the same from `pg_policies`, so a Storage or Realtime policy written outside PermDock (better-supabase `permdock` mode) cannot grant more than the application does.
