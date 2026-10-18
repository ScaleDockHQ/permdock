---
"permdock": minor
---

The catalog lists a policy's `oauthScopes` as `oauthScopes: [{ scope, permissions }]`, and `authorizationProvider` from `permdock/better-supabase` merges them into `delegation.scopes`, so better-supabase's SQL checks accept a token whose `scope` is `mcp:read`. New doctor check PD070 warns when the catalog on disk lacks them; run `permdock collect`.
