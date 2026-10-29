---
"permdock": minor
---

Breaking: `permdock/better-supabase` now needs `better-supabase` 0.39.0 or later; run `better-supabase codemod 0.32` for its auth renames (`requireTenant`, `auth.tenant`, `bsb.claims()`, `bsb.evictSession()`). `authorizer` reads `context.intent`, validates `source: "input"` rows and `change` pairs, and resumes `PermDock-Approval` tokens with the new `store` option; `blockMembershipSource` takes `tables` from `blockTables(config)`; the token hook names `memberships_truncated` as its one `truncatedClaim`.
