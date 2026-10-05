---
"permdock": minor
---

An instance check without a row (`can(permission, undefined)` in a page guard) now answers from memberships of the first scope only. A membership of a nested scope, such as a portal contact's `customer` membership inside an organization, applies only when the row carries that scope's key or when `team(id)` selected its instance; otherwise the check is `denied` with `scope`. This is a breaking change for an app that relied on a nested role passing an organization-level guard: pass the row, or select the instance with `team(id)`. Snapshots already denied these checks and are unchanged.
