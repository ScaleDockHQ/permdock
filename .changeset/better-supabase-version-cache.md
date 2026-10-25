---
"permdock": minor
---

`permdock/better-supabase` joins better-supabase 0.15's version cache. `subjectFromBetterSupabase` accepts a `SessionSnapshot` from `bsb.getRequestSession()` and maps its `iat` and `authz_ver` claims. `authorizer` shares one instance per claims and tenant through the request-scope `memo` 0.15 passes to `evaluate`. One `memoryVersionCache` passed to both `claimsFirst` and `createNext({ versions })` is evicted by `bsb.invalidateSession` and `subscribeAuthzVersions`.
