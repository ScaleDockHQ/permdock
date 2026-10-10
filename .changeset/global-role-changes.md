---
"permdock": minor
---

`decideRoleChange` checks a change to a global role. Pass `scope: 'global'` and no `id` for a role declared without `on`; `RoleChange` is now a union in which `id` is required for a named scope and absent for `'global'`, so a helper typed `Partial<RoleChange>` needs `Extract<RoleChange, { id: string }>`. The authority is the one `assignableRoles({ scope: 'global' })` lists, which is new: the assignable global roles the subject may hand out through its own global roles. `exclusiveWith`, `managedBy: 'idp'` and the self-change rule apply as for a scoped role, a role held at a named scope is denied with `scope`, and an `id` on a global change is denied with `validation`. The snapshot-backed client answers `assignableRoles({ scope: 'global' })` with an empty list.
