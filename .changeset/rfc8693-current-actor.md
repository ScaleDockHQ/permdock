---
"permdock": patch
---

`permdock/jwt` and `permdock/supabase` now take the outermost RFC 8693 `act.sub` as the actor. RFC 8693 section 4.1 makes that the current actor and says prior actors in nested `act` claims must not decide access; before, the innermost (oldest) actor was used. Every level of the chain must carry a non-empty string `sub`, or the subject is anonymous with cause `invalid-chain`. The full chain stays on `delegation.chain`.
