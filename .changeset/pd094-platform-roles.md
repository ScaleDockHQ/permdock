---
"permdock": patch
---

PD094 reports `blocks.invitations.options.platformRoles` only when it equals the `platformRoles` the provider fills. It reported any config that named `permdock_can_assign_any`, so a deliberately narrower override, such as `canAssign` for the `global` scope with a `through.where`, failed the doctor.
