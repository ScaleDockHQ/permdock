---
"permdock": minor
---

`authorizationProvider` sets `tenant` on each `roleSources` entry, scopes its `where` by the custom-role table's `scope` column, and asks `platformRoles.canAssign` at the `'global'` scope, so `blocks.memberships.options.roleThrough` and `blocks.invitations.options.platformRoles` become restated. `rls.customRoleWrites.roles.globalScope` names the `scope` value of a platform role row for `platformRoles.through.where`.
