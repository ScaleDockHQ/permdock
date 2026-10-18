---
"permdock": patch
---

`permdock codemod 0.5` rewrites `permittedIds(permdock, …)` and `mayUse(permdock, …)` to the instance methods `permdock.permittedIds(…)` and `permdock.mayUse(…)` and drops the import once nothing reads it. It no longer lists `decideCredential(permdock, request)` as a call to change: it stays a function that takes the instance first.
