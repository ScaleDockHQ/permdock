---
"permdock": minor
---

`permdock/ssf` transmits as well as receives: `signSet` signs a Security Event Token, `pushSet` delivers it over RFC 8935 push, and `setPollHandler` serves RFC 8936 poll from a `SetQueue` (`memorySetQueue` in process). `caepEvents` and `riscEvents` build the CAEP and RISC events, and the stream configuration types are exported. `testSetQueue` in `permdock/testing` is the queue's conformance runner.
