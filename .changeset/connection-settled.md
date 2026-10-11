---
"permdock": patch
---

Streamed subscription items wait for a pending revalidation, so an item after a revocation event is checked against the rebuilt instance instead of the revoked one. `Connection` gains `settled()`, which resolves once queued revalidations finish.
