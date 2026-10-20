---
"permdock": minor
---

`rls.tokenScopes: true` makes `rls generate` write `permdock_token_scope_allows(p_grant)` and narrow `permdock_has`, every `permitted_<scope>_ids` and the helper-free allows for a delegated token (a `client_id`, or an `act` that is not a support or impersonation session) to the permissions its `scope` claim reaches. The Supabase manifest lists the helper and `rls.tokenScopes`. `authorizationProvider`'s `delegation.scopes` from `permdock/better-supabase` now also maps a renamed permission's former scope to its current key, as the in-process check does.
