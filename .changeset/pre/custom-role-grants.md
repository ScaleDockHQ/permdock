---
'permdock': minor
---

Permission-level custom roles bounded by a ceiling. `CustomRole` gains `grants` (`{ permission, effect? }`, no conditions) and an optional `team`; `includes` is now optional. Every custom role resolves through `resolveCustomRole(policy, role)`: its included roles' grants plus its own allows, minus its own denies, intersected with the code allows of the declared `assignable` roles in its scope. Grants inherit the declared grant's condition, approval and limit, and keys outside the ceiling are dropped and reported by `validateCustomRole` and `permdock doctor` PD023.

`assignablePermissions({ tenant? })` joins `assignableRoles`: both intersect the ceiling (narrowed by `RoleSource.assignable`) with what the subject holds, and a held role or granted permission with `meta.manageRoles: true` lifts the intersection. Snapshots carry resolved custom-role grants and a per-tenant `assignable` list, read by `fromSnapshot` and the new `useAssignablePermissions` hook (Vue, Solid, React Native; `assignablePermissions` store in Svelte). `testRoleSource` accepts `{ policy }` to check custom-role grants against the ceiling.

Behaviour change: an `includes` entry is now bounded by the ceiling too, so a custom role that included a global or non-assignable role no longer reaches that role's grants, and `assignableRoles()` now also lists assignable roles whose every allow the subject holds.
