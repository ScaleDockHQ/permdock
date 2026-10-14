---
"permdock": minor
---

`permdock/better-supabase` adds `hookCan` and `handlerCan` for `better-supabase/workflow-sdk`, `supportPolicy` for `supportSessions`, `subscriberPolicy` for per-subscriber fan-out and `principalSource` for principals and identity links. `authorizationProvider({ functions: { holdersOf, actorMayWrite } })` fills `holdersOf` with `permitted_<scope>_users` and `actorMayWrite` with `permdock_actor_may_write()`; both are off by default until a better-supabase release accepts them.
