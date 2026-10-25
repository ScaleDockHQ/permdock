---
"permdock": minor
---

`authorizer` from `permdock/better-supabase` takes `memberships`, `versions` and `intent`. It wraps `memberships` in `claimsFirst(source, { onStale: 'reread', versions })` with the version cache better-supabase passes at runtime, and checks `read`, `list` and `view` actions and batches with intent `read`, every other check with `write`.
