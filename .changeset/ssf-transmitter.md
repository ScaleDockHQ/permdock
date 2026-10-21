---
"permdock": minor
---

`permdock/ssf` serves the transmitter side of SSF 1.0: `ssfTransmitter({ issuer, streams, queue, signer, authorize })` answers the `/.well-known/ssf-configuration`, stream, status, verification and per-stream poll endpoints over an `SsfStreamStore` (`memorySsfStreamStore()`, `testSsfStreamStore` in `permdock/testing`), and `fanOutSet(event, { streams, queue, signer })` delivers one event to every stream that requested it. `pollSets(options)` is one RFC 8936 poll request that answers SETs unverified; `receiver.poll` now uses it and reports a failed poll request as a `poll-failed` event instead of rejecting.
