---
"permdock": patch
---

`permdock rls generate` writes `member_<scope>_ids_for` for a Supabase scope that has no membership source when another scope has one. The function returns no rows, so better-supabase's `memberIdsFor` can call it for every scope.
