---
"permdock": minor
---

`rls.rowHelpers` also writes `permitted_<resource>_row(p_row, p_permission)`: whether the caller may act on one row value, decided by the same allows and denies as `permitted_<resource>_rows` but read from the row's columns instead of looked up by id. A table's own `select` policy written as `using (permdock.permitted_doc_row(doc, 'doc.read'))` now admits a row the same statement inserts, so `insert ... returning` no longer fails with a row-level security error.
