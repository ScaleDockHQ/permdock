---
"permdock": patch
---

`permdock/react/lazy` and the `evaluator: "lazy"` provider of `permdock/next` no longer load SHA-256 or expand the snapshot before the evaluator arrives: the first chunk of `PermDockProvider` plus `usePermission` falls from 15,301 B to 13,840 B gzipped. A check without a row still answers from the snapshot's `typeLevel`, and the evaluator loads on the first check that needs it.
