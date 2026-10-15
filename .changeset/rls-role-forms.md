---
"permdock": minor
---

`rls migrate` and `rls import` read role checks, not only permission checks.

- `rls.roleValues` maps a role value the existing SQL compares against (a string literal or an enum label) to the PermDock role it is: `roleValues: { org_admin: 'owner' }`.
- `rls.migrate.helpers` takes a `role` form: `has_org_role(org_id, 'org_admin')` becomes `(org_id in (select permdock.member_organization_ids(array['owner'])))`. `rls generate` writes the overload `member_<scope>_ids(p_roles text[])` for each scope a `role` helper names, and a shim keeps unrewritten callers working. A role argument that is not a literal is skipped with `dynamic-role`; an unmapped, undeclared role with `unknown-role`.
- `rls import` reads `role = any(array[…])` and enum casts in membership subqueries, and writes the PermDock name for each mapped role value in `memberOf` conditions and the imported `role_permissions` rows.
