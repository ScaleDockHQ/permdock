---
"permdock": patch
---

The `permdock-wire` skill passes the unawaited loader promise to the `permdock/next` `PermDockProvider` as `snapshot`, not `snapshotPromise`, and says a layout fetches while pages, loaders and actions decide.
