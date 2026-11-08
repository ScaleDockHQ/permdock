---
"permdock": minor
---

`rls generate` writes five set helpers ([#302](https://github.com/ScaleDockHQ/permdock/issues/302)): `permitted_<scope>_id_array(p_grant)`, `permdock_<root scope>_has(p_grant, p_tenant)`, and for each `rls.rowHelpers` resource `permitted_<resource>_rows(p_permission, p_tenant)`, `permitted_<resource>_ids_in(p_permission, p_ids)` and `permitted_<resource>_count(p_permission, p_tenant, p_cap)`. The tenant and count forms need a `memberOf` relation to the root scope.
