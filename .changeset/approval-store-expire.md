---
"permdock": minor
---

`testApprovalStore` takes `capabilities: { expire }` and then checks that a new ask replaces an expired request. The docs now say that `reopen` opens a second client over the same backend, and that a store replaces only an `expired` or past-deadline record.
