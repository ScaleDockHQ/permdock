---
"permdock": minor
---

`authorizationProvider({ rowHelpers: true })` fills better-supabase's `rowsWith` and `rowsWithFor` templates from the `permitted_<resource>_rows` helpers that `rls.rowHelpers` writes, so better-supabase record actions with `rows` check the rows a caller holds a permission on, as the generated policies decide them. It lists each helper in `requires` and, when the manifest names none, adds a problem. The option needs better-supabase 0.22 or later and is off by default, so providers for earlier releases are unchanged.
