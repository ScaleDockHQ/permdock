---
"permdock": minor
---

`authorizer` and `toolPolicy` from `permdock/better-supabase` take `onError(error, { permission, tenant })`, a `BetterSupabaseOnError`, which receives every error a check throws; the check still denies.
