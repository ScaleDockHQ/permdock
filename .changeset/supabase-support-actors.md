---
"permdock": minor
---

`permdock/supabase` reads `act.kind` as better-supabase 0.5.1 writes it: `support` becomes actor kind `support` with `sessionId` and `readOnly`, and `impersonation` becomes actor kind `impersonation`. Neither carries a delegation, so they reach only what a policy delegation names. An actor with `readOnly: true` gets only the read-only permissions of each policy delegation (`readOnly` on `policy.delegations`); other permissions deny with `not-delegated`, and `mayUse` follows the policy delegation ceiling. An unknown `kind`, or a support level without `session_id`, is the anonymous subject. `supabaseClaims()` and `supabase-claims-v1.json` validate the new `act` fields.
