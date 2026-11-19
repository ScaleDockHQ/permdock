---
"permdock": minor
---

`authorizationProvider({ ..., roleIn: true })` fills better-supabase's `functions.roleIn` with `permdock_role_in`, so with `blocks.memberships.options.roles.many` its `membership_roles` trigger refuses another organization's custom role (SQLSTATE `23514`, `MEMBERSHIP_ROLE_SCOPE`). The option needs better-supabase 0.77.0, since older releases refuse the key, and is off by default; `problems` reports it when the manifest lists no `permdock_role_in`.
