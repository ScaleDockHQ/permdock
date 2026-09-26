---
'permdock': patch
---

`approvalsHandler`'s `subject` option now accepts an async resolver that resolves to `null` or `undefined` (no session), matching what the handler already did at runtime: the request is refused as unauthenticated.
