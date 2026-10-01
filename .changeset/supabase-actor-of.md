---
'permdock': minor
---

`permdock/supabase` exports `actorOf(claims)` and `delegationOf(claims)`, the rules `subjectFromSupabase` uses for the acting app: `actorOf` returns `{ ok: true, actor? }` with the innermost `act` `sub` (or `client_id`) and a frozen copy of the chain, or `{ ok: false, reason: 'invalid-chain' }`, which must deny; `delegationOf` returns the `scope` claim as `{ scopes }`. `supabaseClaimFixtures` entries now state the expected `actor` and `delegation`.
