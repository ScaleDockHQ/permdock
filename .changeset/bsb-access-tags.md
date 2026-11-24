---
"permdock": minor
---

`permdock codemod bsb-access-tags` moves plain `permitted_<scope>_ids('<key>')` tenant policies into a better-supabase `@bsb access` tag when the key's rows are provably the same. `rls verify --introspect` treats the policies those tags render as generated.
