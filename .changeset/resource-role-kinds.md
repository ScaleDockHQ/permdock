---
'permdock': patch
---

`permdock rls generate` applies a role's `for` to resource-role and nested-scope membership tables too: the `exists` check counts a membership only when its `via` column lists an allowed kind, and a table without a `via` column holds such a role for nothing, matching `decide`.
