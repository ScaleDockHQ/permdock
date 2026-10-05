---
"permdock": minor
---

`permdock/approvals` exports `storedApprovalToken(store, decision, { denyPending?, now? })`, the helper the adapters use to resume a call by its recomputed token, so an application that decides approvals in its own gate passes it to `resumeDecision` instead of reimplementing it. Its third argument is now an options object.
