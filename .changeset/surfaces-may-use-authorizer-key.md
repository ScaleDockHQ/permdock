---
"permdock": patch
---

`mayUse` and `mayUseMany` read the instance's expanded snapshot without the wire compaction and the type-level table, so an MCP `tools/list` or tool call with 150 memberships of 20 roles over 300 tools takes 24 ms instead of 290 ms. The `permdock/better-supabase` `authorizer()` serialises a claims object once per request scope instead of once per check; the memo key is unchanged.
