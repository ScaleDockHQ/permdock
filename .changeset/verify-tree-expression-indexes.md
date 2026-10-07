---
"permdock": patch
---

`rls verify --tree` also seeds distinct values in a column that a unique expression index reads, such as `name` in `(drive_id, coalesce(parent_id, ''), lower(name))`. The unique columns came only from the index's plain key columns, so every sibling row got the same placeholder and the seed failed on such an index.
