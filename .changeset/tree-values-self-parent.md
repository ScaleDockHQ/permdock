---
"permdock": patch
---

`rls.treeValues` now picks the self-parented resource when several resources map to the same table, so a `file` resource listed before a self-parented `fileNode` on `public.file_nodes` no longer fails with "must be a self-parented folder". Two self-parented resources on one table fail with an error that names both.
