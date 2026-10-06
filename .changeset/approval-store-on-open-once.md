---
"permdock": patch
---

`supabaseApprovalStore`'s `onOpen` now runs once per stored request. A repeated ask whose token finds the request still open keeps the stored request, as before, but no longer runs `onOpen` again, so an app that notifies approvers or opens its own record there does not need to make it idempotent. An open whose stored request cannot be read back runs no `onOpen` either.
