---
"permdock": minor
---

`definePolicy({ oauthScopes })` maps coarse OAuth scopes an authorization server issues (`mcp:read`) to the permissions they cover. A token holding one is delegated those permissions in every decision, snapshot and listing, `permdock/mcp` and `permdock/a2a` accept it in their scope pre-checks, and `insufficient_scope` challenges (MCP, A2A and the server kernel) name the first coarse scope that covers the permission instead of a `<resource>:<action>` scope the server cannot issue.
