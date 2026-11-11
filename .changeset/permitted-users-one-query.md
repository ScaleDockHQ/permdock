---
"permdock": patch
---

`permitted_<scope>_users(p_permission, p_id)` over an `rls.memberships` table is one query: it reads each candidate's grant keys on `p_id` and globally, with the same bodies as `permitted_<scope>_permission_keys_for`, and applies the allow and deny keys of `p_permission` once, instead of calling `permitted_<scope>_ids_by_permission_for` and `permdock_has_permission_for` per candidate. The answer is unchanged, including denies, custom roles, expiry and suspension. A member who belongs to many instances no longer makes each call list all of them: on 200 organizations with 30 multi-tenant admins and 370 holders it runs in 17 ms instead of 115 ms. Scopes whose memberships come from sources keep the per-candidate form.
