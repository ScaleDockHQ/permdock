---
"permdock": patch
---

`permdock rls verify --tree` no longer seeds placeholders that break a column's constraints. A required column it fills gets the first label of its enum type, or a value its single-column check constraint admits (the first literal of an `= 'x'` or `in (...)` check, the bound of a `> n` or `>= n` check), before falling back to a placeholder of its type. The new `rls.treeValues` sets column values for every row seeded into a table, keyed by table name, for constraints the generator cannot read.
