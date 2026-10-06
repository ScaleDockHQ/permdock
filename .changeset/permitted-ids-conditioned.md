---
"permdock": minor
---

`permittedIds` and the SQL permission-key helpers now agree on what a row condition is. A `fields` list is not one, so `permittedIds` lists the instances an allow limited to some fields reaches, as `grant_keys` and `permitted_<scope>_ids_by_permission` already did; a validity window is one, as in SQL. A new option lists the instances a conditioned allow reaches and subtracts only unconditional denies, leaving the row condition to the caller: `permittedIds(permdock, permission, scope, { conditioned: true })` in process and the overload `permitted_<scope>_ids_by_permission(p_permission, p_conditioned boolean)` (and its `_for` form) in SQL. `grant_keys` takes `p_effect` `'conditioned-allow'` and `'conditioned-deny'` for the keys that carry a row condition. Behaviour change: `permittedIds` without the option now lists field-limited allows and leaves out allows with a validity window.
