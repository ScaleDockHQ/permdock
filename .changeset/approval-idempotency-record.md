---
"permdock": minor
---

`permdock/approvals` exports the `IdempotencyRecord` and `IdempotentCall` types with `idempotencyRecord`, `idempotencyRecordKey` and `matchesIdempotencyRecord`, which build and compare `Idempotency-Key` records exactly as `approvalsHandler` stores them.
