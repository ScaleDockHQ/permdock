---
"permdock": patch
---

Security: an action can set `meta.interactiveOnly: true` to keep it to the user's own session. `decide`, `mayUse` and client snapshots refuse it to a subject with an actor or a delegation, and no OAuth scope maps to it. The generated SQL helpers, `can_<resource>` and table policies refuse it to a token with an API key claim, `client_id` or `act`, and their memo keeps those tokens apart from the user's session. `permdock_can_assign` refuses `transferOnly` roles to the same tokens. `authorizationProvider` lists the keys as `delegation.interactiveOnly` for better-supabase. Mark ownership transfer, organization deletion and similar actions, then run `permdock collect` and `permdock rls generate`.
