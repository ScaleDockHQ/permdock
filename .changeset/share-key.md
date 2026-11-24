---
"permdock": minor
---

`authorizationHooks` sets `shareKey`, and `grantFingerprint` from `permdock/better-supabase` returns the `gf1:` digest of a caller's grants for a list of permissions, so callers with equal grants share one `share: "tenant"` cache entry.
