---
"permdock": minor
---

`authorizationHooks().shareKey` answers for the active tenant of a token with `memberships_truncated` when the token holds an entry of another tenant, because the hook keeps the active tenant's entries first. Doctor `PD138` counts the users the hook budget truncates.
