---
"permdock": patch
---

`usePermDock` no longer logs "A component was suspended by an uncached promise" on the first check under the lazy evaluator. The store now keeps returning the evaluator load it suspended on after that load settles, so a render React replays sees the same promise.
