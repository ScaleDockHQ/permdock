---
"permdock": minor
---

`permdock/mcp`: a tool registered with `permission: null` is public, listed and called with no check; leaving `permission` out still throws. A tool's `permission` may be a list, with `anyOf: true` for any-of, and `rows(args)` checks every row the call touches. The new `unscopedTokens: "subject"` option decides a token carrying none of the policy's scopes, such as a Supabase session token, on the subject with no scope check and no delegation; the default `"deny"` refuses it as before. `permissionFor` may return a list or `null`.
