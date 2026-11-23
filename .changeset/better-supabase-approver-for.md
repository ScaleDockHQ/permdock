---
"permdock": patch
---

`authorizationProvider` from `permdock/better-supabase` no longer sets `functions.approverFor`. better-supabase reads it as the users who may decide a request, and `permdock_approver_for_ids()` answers the users the caller decides for. Tested against better-supabase 0.84.0.
