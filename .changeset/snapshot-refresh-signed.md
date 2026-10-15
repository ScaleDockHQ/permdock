---
"permdock": minor
---

With a `verifier` configured, the client store refuses an unsigned snapshot from `refresh` and turns `stale`. Before, a plain JSON body from `snapshotUrl` was applied without verification, which let a network attacker downgrade a signed endpoint.
