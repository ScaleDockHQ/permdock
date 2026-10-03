---
"permdock": minor
---

`permdock rls generate` compiles two more rules. `deny(permission, { to: actor('oauth-client') })` becomes a RESTRICTIVE policy that refuses rows while the token carries `client_id` or `act`, so a third-party app's Supabase token stops where the in-process `decide` stops it. `contains` on a column the resource schema types as an array compiles to `value = any(column)`, cast to the item type, instead of `LIKE` over the column's text.
