---
"permdock": minor
---

Breaking: `permdock/mcp` treats a token with no scopes and no `authorization_details` as a session token. It passes the scope check in `tools/list` and in calls, raises no scope challenge, and gets no actor and no delegation, where it was refused with `insufficient_scope`. A token with scopes, none of them the policy's, is still governed by `unscopedTokens`.
