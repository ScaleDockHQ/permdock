---
"permdock": minor
---

`authorizationProvider` from `permdock/better-supabase` takes `approvers`, keyed by request kind, and fills better-supabase's `isApprover` through `permdock_is_approver`. New `accessReviewApplier` applies an access review's revoked items through the organizations and invitations blocks, then marks each item applied.
