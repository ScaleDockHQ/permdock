---
"permdock": patch
---

The better-supabase provider's `rowsWith` template casts better-supabase's `text[]` candidate ids to the row helpers' id type, so generated block functions such as `can_subject` no longer fail with `42883 function permitted_<resource>_rows(unknown, text[]) does not exist` on `uuid` ids. `permdock supabase inspect` records each row helper's `idType` (from `rls.idTypes`, else `uuid` on Supabase and `text` on Neon) in `names.resources`, and the provider requires `permitted_<resource>_rows(text, <idType>[])`. A manifest written before this release has no `idType` and reads as `uuid`. When the row helpers take different id types, the template calls the one-argument `permitted_<resource>_rows(permission)`, which answers the same without narrowing to the candidates. The cast is on the candidate array, never on the id column, so its index stays usable. Run `permdock supabase inspect --out` to record the id types.
