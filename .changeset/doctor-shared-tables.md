---
"permdock": minor
---

New doctor check PD075 warns when `rls.tables` maps two resources to one table, as with `file` and `fileNode` on `file_nodes`, and links to the merge guide. List a table that is split on purpose, with each resource covering disjoint rows, in the new `doctor.sharedTables` option.
