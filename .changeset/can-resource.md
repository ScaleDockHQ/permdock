---
"permdock": minor
---

Breaking: the row-valued and per-id helpers are `can_<resource>(p_row | p_id, p_permission)`. `permitted_<resource>_row` is no longer generated. Both forms call `permitted_<resource>_match`.
