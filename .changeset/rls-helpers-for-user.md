---
"permdock": minor
---

`rls generate` in `database` mode adds `permdock_has_for(p_user, p_grant)` and one `permitted_<scope>_ids_for(p_user, p_grant)` per scope: the answers of `permdock_has` and `permitted_<scope>_ids` for a user the caller names, from the same tables with the same expiry and suspension filters and no active-tenant narrowing. They are for trusted SQL that acts for a stored user, such as a job, a trigger or an approval decided later, which otherwise had to rewrite `request.jwt.claims` to ask the helpers. `execute` is revoked from `public`, `anon` and `authenticated`; grant it to a backend role yourself when it calls them directly.
