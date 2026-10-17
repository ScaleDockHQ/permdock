---
"permdock": minor
---

`subjectFromSupabase`, `actorOf` and `supabaseClaims()` from `permdock/supabase` read the `act.kind: "agent"` claim better-supabase's `agentClaims` mints: the actor is `{ id, kind: "agent", tools }` and the token's `scope` becomes its delegation. Before, such a token was an invalid chain and mapped to the anonymous subject.
