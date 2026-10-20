---
"permdock": minor
---

`rls.tables` entries accept `{ table?, via: { table, column, key?, id?, type?, scope? } }`: `rls generate` writes the `permitted_<parent>_ids(p_grant)` security definer helper and policies that filter the child's parent id through it, and `rls explain` lists the binding.
