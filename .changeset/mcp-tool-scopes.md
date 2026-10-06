---
"permdock": minor
---

`permdock/mcp` tools take `oauthScopes`, the OAuth scopes that reach the tool in place of those derived from its permission (the permission's own scope and the coarse scopes of `oauthScopes` in the policy). Any one of them reaches the tool and the first is the one an `insufficient_scope` challenge names. They only narrow: the token's delegation must still cover the permission, so the policy lists the permission under each coarse scope that may reach it and each tool names the one it needs. Two tools that share one permission can now need different coarse scopes, such as reading an export with `mcp:read` and creating one with `mcp:write`. Under `enforce: 'procedure'`, `oauthScopesFor(name)` supplies them for the listing. An empty list throws at registration. Tools without the option behave as before.
