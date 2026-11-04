---
"permdock": minor
---

`memoryVersionCache` and `instanceCache` default to 30,000 ms (`maxStaleMs` is optional; the 60 s ceiling stays), so a removed member keeps read access for up to 30 s by default. `memoryVersionCache({ shared })` takes a `VersionStore`, `betterSupabaseVersionCache(cache)` in `permdock/better-supabase` wraps better-supabase's `createVersionCache`, and `authorizer` and `permdockFor` accept either cache. `permdock/testing` gains `testVersionStore`.
