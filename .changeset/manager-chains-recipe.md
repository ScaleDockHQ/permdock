---
"permdock": patch
---

The relationships page documents manager chains: a self-parented `employee` with a `{ principal }` relation walked `through: 'parent'` compiles to the closure subquery, so no `RlsTableVia.recursive` option is added.
