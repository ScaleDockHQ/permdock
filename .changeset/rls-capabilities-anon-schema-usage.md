---
"permdock": patch
---

`permdock rls generate` with `rls.capabilities` grants `anon` usage on a non-`public` helper schema. Without it the `<table>_select_anon` policies could not call `permdock_capability_ids`, and a share-link capability read no rows.
