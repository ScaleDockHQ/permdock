---
'permdock': patch
---

Generated RLS keeps parity with `decide`. `contains` escapes `\`, `%` and `_` before `LIKE`. `rls.suspension` now also applies to the inline membership `exists`, the root-scope tenant-claim check and the graph helpers. `rls migrate` counts only allow seeds when it checks that a key is granted on a scope.
