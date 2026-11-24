---
"permdock": minor
---

`permdock codemod config --prune` also removes a `rls.actions` verb set to `'none'` that compiles to no command, and `rls.tables` and `rls.scopeTypes` entries equal to what the schema files resolve. The schema readers, the read-only actor guards and `rls report` find `supabase/` in the nearest parent directory of the same checkout, so a config in a workspace package reads the repository's Supabase project; `rls.readOnlyActors` then guards the write policies of that project's tables too.
