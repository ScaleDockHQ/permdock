---
"permdock": patch
---

`permdock.snapshot()` is typed by overload: without a `signer` it returns `Snapshot`, with one `Promise<string>`, and only an options value whose `signer` the compiler cannot see returns either. Callers drop the `instanceof Promise` check or the `parseSnapshot` round trip they needed before. The options type is exported as `SnapshotOptions`. An instance from `fromSnapshot` now signs when given a `signer`, as the overloads say, instead of returning the plain snapshot.
