---
"permdock": minor
---

The `onError` sink of `protectServer` in `permdock/mcp` now receives `tenant` next to `permission` and `name` (`McpErrorContext`), so a `BetterSupabaseOnError` from `permdock/better-supabase` can be passed as is. `tenant` is what the `tenant` option resolves for the call, or `null`.
