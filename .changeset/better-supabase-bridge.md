---
"permdock": minor
---

`permdock/better-supabase` adds `hookCan` and `handlerCan` for `better-supabase/workflow-sdk`, `supportPolicy` for `supportSessions`, `subscriberPolicy` for per-subscriber fan-out and `principalSource` for principals and identity links. `authorizationProvider` fills `holdersOf` with `permitted_<scope>_users` and `actorMayWrite` with `permdock_actor_may_write()` when the manifest lists those helpers.
