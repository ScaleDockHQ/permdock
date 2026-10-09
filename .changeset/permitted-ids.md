---
"permdock": minor
---

`permittedIds(permdock, permission, scope, { within?, conditioned? })` lists the instances of `scope` in which the subject holds `permission` with no row condition, minus the instances a deny reaches, within its delegation: the in-process mirror of `permitted_<scope>_ids_by_permission`. Apps no longer loop over memberships calling `can` with a made-up row to list, for example, the customers a portal contact may open. Both sides treat a validity window as a row condition and a `fields` list as none. With `conditioned: true`, and the SQL overload `permitted_<scope>_ids_by_permission(p_permission, p_conditioned boolean)` and its `_for` form, the list includes the instances a conditioned allow reaches and subtracts only unconditional denies, leaving the row condition to the caller. `grant_keys` takes `p_effect` `'conditioned-allow'` and `'conditioned-deny'` for the keys that carry a row condition.
