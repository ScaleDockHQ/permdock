---
"permdock": minor
---

Breaking: `permdock/better-supabase` needs better-supabase 0.58.0 or later (`>=0.58.0`); upgrade better-supabase before this release. `authorizationProvider` returns better-supabase's `AuthorizationProvider`, and the `PermDockAuthorizationProvider` type is removed: import `AuthorizationProvider` from `better-supabase/contract` instead. `blockApprovalStore` reads a request with the approvals block's `consumed` status as approved and consumed.
