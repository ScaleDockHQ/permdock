---
"permdock": minor
---

`permdock/mcp` takes `actorKind` on `createPermDock` and `subjectFromMcp`, the `kind` of the actor built from `authInfo.clientId` (default `'mcp-client'`). Set it to `'oauth-client'` so an OAuth token is the same actor kind in `permdock/mcp` as in `permdock/supabase`, `permdock/jwt` and `permdock/a2a`, and one policy delegation covers it on both surfaces.
