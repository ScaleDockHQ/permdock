---
'permdock': minor
'@permdock/testing': patch
---

`ReplayStore.remember` accepts an optional `expiresAt`; the SSF receiver cancels pending approvals on `session-revoked` when `approvals` is set.
