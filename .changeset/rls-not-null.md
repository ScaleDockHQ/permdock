---
"permdock": patch
---

Generated RLS renders `not` and deny policies as `(…) is not true`, so a row whose deny condition is NULL stays visible, as `can()` allows it. Run `permdock rls generate` again to pick this up.
