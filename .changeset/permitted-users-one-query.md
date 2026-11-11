---
"permdock": patch
---

`permitted_<scope>_users(p_permission, p_id)` over an `rls.memberships` table is one query: it reads the grant keys of the instance's membership rows and of the global-role holders, and applies the allow and deny keys of `p_permission` once, instead of calling `permitted_<scope>_ids_by_permission_for` and `permdock_has_permission_for` per candidate. The answer is unchanged, including denies, custom roles, expiry and suspension. On PGlite with 200 organizations, 30 multi-tenant admins and 370 holders (`tests/integration/bench/permitted-users.test.ts`) it runs in 3 ms instead of 46 ms. Scopes whose memberships come from sources keep the per-candidate form; run `permdock generate` to rewrite the helper.
