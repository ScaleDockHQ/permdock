---
"permdock": minor
---

`resumeDecision` takes a `ttl` in milliseconds for the request it opens, and a request opened by `requestApproval` or any adapter without one now stays open for the store's `ttl` (`memoryApprovalStore({ ttl })`, or the new optional `ApprovalStore.ttl`) instead of always one hour. A grant's `approval.ttl` still caps the window, and a `ttl` that is not a positive whole number of milliseconds throws a `RangeError`.
