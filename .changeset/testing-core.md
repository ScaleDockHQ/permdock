---
"permdock": minor
---

New entry `permdock/testing/core` exports `policyMatrix(policy, config)`, `testRlsParity` and `testOrmParity` without importing a test runner, so `node:test`, Bun, Deno or Jest can run a policy matrix. `policyMatrix` returns `{ cells, missing }` with the `failures` of each cell; `describePolicy` now asserts that report under Vitest, and `permdock/testing` re-exports the core.
