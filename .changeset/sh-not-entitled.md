---
"permdock": minor
---

A grant whose roles the subject holds but whose `plan` grantee it lacks now denies with the new reason `not-entitled` instead of `no-grant`, with the grantee in `to`; a plan grant whose roles are not held adds no denial. When every denial is `not-entitled`, HTTP adapters answer `403` `/not-entitled` with `plans` (the plan keys that would grant), `describe(decision)` returns `kind: 'upgrade'` with `plans`, and the new `requiredPlans(decision)` returns the list. Snapshots carry these grants as `notEntitled` entries, which grant nothing, so `usePermission` in every UI adapter gets the same reason and plans as `decide` on the server.
