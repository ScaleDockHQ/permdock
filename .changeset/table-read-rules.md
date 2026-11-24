---
"permdock": minor
---

`permdock rls report` counts `rls.tableReads` per rule (`form`, `follows`, `via`, `walk`, `owner`, `condition`, `restrictive`, `fields`, `unknown`) and lists each `row` table with its rules. For a `form` table, `permdock codemod bsb-access-tags --check`, `permdock rls explain` and `rls.tableReads[].reason` in the manifest name the grant that keeps the policy off an `@bsb access` tag.
