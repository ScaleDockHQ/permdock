---
"permdock": minor
---

`rls.readOnlyActors` adds a restrictive policy per table and write command that refuses writes from support and impersonation sessions (the token's `act` claim) unless `act.read_only` is `false`, replacing the hand-written policy the support access guide showed.
