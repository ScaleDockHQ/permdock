---
"permdock": minor
---

A route that checks no permission can now require OAuth scopes. `protect(null, loadData?, { oauthScopes })` in `permdock/server` and the Hono, Express, Fastify, Elysia and Node adapters, `withPermDock({ oauthScopes })` without `protect` in the Supabase middleware, and an `operationPermissions` entry with only `oauthScopes` (read through `operations` on `permdock/server`) gate a route such as a chat endpoint: an anonymous caller gets `401`, a delegated token holding none of the scopes gets the same `403` `insufficient_scope` challenge as a permission route, and a first-party session passes. The guard is a `ScopeGuard`, with no `decision`. An app no longer needs its own rule that maps HTTP methods to scopes. Routes with a permission behave as before.
