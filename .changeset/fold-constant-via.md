---
"permdock": patch
---

`permdock rls generate` folds a constant membership kind (`rls.memberships` `via: { value }`, or a table with no `via`) at generation time instead of emitting a per-row `case` over every role with `for`: a role the kind allows gets no filter, and one it excludes is filtered out by name. Access is unchanged.
