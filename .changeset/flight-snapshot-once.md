---
"permdock": patch
---

`permdock/next` writes one snapshot copy to the Flight stream for nested `PermDockProvider`s with equal options: `PermDockProvider` and `getSnapshot` share one memoised promise per request. In development one warning reports an equal snapshot passed as two separate `snapshot` promises.
