---
"permdock": minor
---

`permittedIds(permdock, permission, scope, { within? })` lists the instances of `scope` in which the subject holds `permission` with no row condition, minus the instances a deny reaches, within its delegation: the in-process mirror of `permitted_<scope>_ids_by_permission`. Apps no longer loop over memberships calling `can` with a made-up row to list, for example, the customers a portal contact may open.
