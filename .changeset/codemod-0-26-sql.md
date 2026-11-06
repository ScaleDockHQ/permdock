---
"permdock": minor
---

`permdock codemod 0.26` renames `permitted_<resource>_row(` to `can_<resource>(`, removes `::text` around a helper call, deletes `own_subject()`, and moves `{ tableOf }` onto the owner's `also` list.
