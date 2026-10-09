---
"permdock": minor
---

`rls.rowHelpers: true` (or a list of resources) makes `permdock rls generate` write `permitted_<resource>_rows(p_permission)`: the ids of the resource's rows the caller may act on with one permission, from the same allows and denies the generated policies use, so closure walks, link hops, the restricted stop, `includes`, groups and `requires` apply without being restated in hand-written policies and functions. Actions with no SQL command get an arm too. `permitted_<resource>_rows_for(p_user, p_permission, p_claims)` answers for a stored user and is executable by no client role; the `neon` dialect gets no `_for` form. It works with `rls.helpersOnly`.

`permitted_<resource>_row(p_row, p_permission)` decides one row value from its columns instead of looking it up by id. A table's own `select` policy written as `using (permdock.permitted_doc_row(doc, 'doc.read'))` admits a row the same statement inserts, so `insert ... returning` passes row-level security.
