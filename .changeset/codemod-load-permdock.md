---
"permdock": patch
---

`permdock codemod 0.5` rewrites `await createPermDock(…)` from `permdock` to `await getPermDock(…)`, any other core `createPermDock` to `getPermDockSync`, and `createPermDock` from `permdock/pdp` to `getPermDock`. A core `createPermDock(…)` that is returned or chained with `.then` is also listed as a manual follow-up.
