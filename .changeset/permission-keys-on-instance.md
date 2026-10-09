---
"permdock": minor
---

`permdock rls generate` writes `permitted_<scope>_permission_keys(p_id)` for each scope: every permission key the caller holds on one instance, as `permdock_has_permission` or `permitted_<scope>_ids_by_permission` would answer each key, in one set-based query. A screen or RPC that checks fifteen permissions on an organization makes one call instead of fifteen. The overload `permitted_<scope>_permission_keys(p_id, p_keys)` answers for the listed keys only. In `database` mode the `_for(p_user, p_id)` and `_for(p_user, p_id, p_keys)` forms answer for a named user and no client role may execute them.
