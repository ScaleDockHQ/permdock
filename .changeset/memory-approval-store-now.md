---
"permdock": minor
---

`memoryApprovalStore({ now })` takes a clock returning an `Instant`; `create`, `cancel`, and `consume` or `expire` without an `at` read it instead of the system clock.
