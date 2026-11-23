---
"permdock": patch
---

`workflowSdkWaiter` registers its hook with `getConflict()` before parking and takes a `pending(token)` step, so a request decided before the hook registered no longer leaves the run parked.
