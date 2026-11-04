---
"permdock": minor
---

`authorizationProvider` fills better-supabase's `memberships[].disabledAt` and `platformRoles`, takes `personas` and the opt-in `subject: true` and `platformRoles: true`, and the hook manifest lists `permdock_subject()`. `permdock doctor` reports a hand-written `own_subject()` as PD093.
