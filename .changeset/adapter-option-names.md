---
"permdock": minor
---

Option names match across adapters.

| Before                                                             | After                                           |
| ------------------------------------------------------------------ | ----------------------------------------------- |
| `permdock/workflow` `createPermDock(policy, { approvals: store })` | `createPermDock(policy, { store })`             |
| `permdock/chat` `createPermDock(policy, { approvals: store })`     | `createPermDock(policy, { store })`             |
| `customRoleSource({ rolesOf: (tenant) => … })`                     | `customRoleSource({ rolesFor: (tenant) => … })` |

`store` is the approval store option on every adapter, and the reader's method has the same name as `CustomRoleSource.rolesFor`.
