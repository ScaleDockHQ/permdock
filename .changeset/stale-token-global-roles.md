---
"permdock": minor
---

A stale token no longer keeps a revoked platform role. `claimsFirst(source, { onStale: 'reread' })` now also replaces `principal.roles` through the new optional `MembershipSource.globalRolesFor`, which `postgrestSources().memberships` implements, and `postgrestSources().refresh(subject)` rereads the principal while keeping `actor`, `delegation`, `session` and the token's other claims, so a stale OAuth client keeps its delegation ceiling.
