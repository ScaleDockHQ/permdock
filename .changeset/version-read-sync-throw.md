---
"permdock": patch
---

`postgrestSources` turns a client that throws synchronously during a batched version read into a rejected read, so the caller's check settles and denies instead of hanging with an uncaught error.
