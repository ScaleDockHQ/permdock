---
"permdock": minor
---

REST routes can now require the OAuth scopes an operation declares, as `permdock/mcp` tools can. `protect(permission, loadData, { oauthScopes })` in every HTTP adapter, or `operations` on `permdock/server` (the result of `operationPermissions`), narrows which coarse scopes reach a route: when the subject carries a token delegation, a token holding none of them is refused before the loader runs with `403` and `WWW-Authenticate: Bearer error="insufficient_scope"` naming the first. A subject without a delegation, such as a first-party session, is not gated, and the decision still needs the delegation to cover the permission. `operationPermissions` entries take `oauthScopes`, read by `oauthScopesForRequest(method, path)` for REST and `oauthScopesForOperation(id)` for `permdock/mcp`'s `oauthScopesFor`, so one declaration narrows both. Routes without the option behave as before.
