---
"permdock": minor
---

BREAKING: `permdock/eve` needs eve 1.2.0 or later, the `ai` and `chat` peers need 7.0.177 and 4.45.0, and `permdock/better-supabase` needs better-supabase 0.81.0 or later. `EveResponseContext` takes `request.interactionId` and `request.principal` in place of `request.requestId`, the decision is `"approve" | "deny"` with no `cancel`, and the session reads `id` and `initiator`. A response on another instance now recomputes the approval token with `request.principal` as the caller. `approvalFor` from `permdock/eve` combines with better-supabase's `strictestApproval`; see [Eve with better-supabase](/docs/adapters/eve#use-with-better-supabase).
