---
"permdock": minor
---

`permitted_<resource>_match(p_row, p_permission)` is the stable row predicate. `permitted_<resource>_rows`, its id-list form and both `permitted_<resource>_row` forms call it. The jsonb term map inside the row helper is gone. `permitted_<resource>_rows` keeps a leading tenant predicate for a root-scope key.
