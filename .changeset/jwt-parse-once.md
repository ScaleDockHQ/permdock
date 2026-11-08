---
"permdock": patch
---

The claims-first helpers read `auth.jwt()` once per call: `permdock_token_current()` and the `memberships` claim rows parse the token one time instead of three to four times. `permdock generate --only rls` rewrites the helper files; no data migration is needed.
