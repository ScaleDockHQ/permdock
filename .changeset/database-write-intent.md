---
"permdock": minor
---

`Intent` adds `'database-write'`, which `authorizer` from `permdock/better-supabase` selects for a write whose `context.enforcement` is `rls`. It reads the authorization version from the cache; `definer` and unset writes stay live.
