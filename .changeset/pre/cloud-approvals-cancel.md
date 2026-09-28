---
'permdock': minor
---

`cloud().approvals` implements `cancel(filter, meta)` over `POST /v1/environments/:env/approvals/cancel`, so session revocation rejects pending Cloud approvals in one call.
