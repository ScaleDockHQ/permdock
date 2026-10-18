---
"permdock": patch
---

`permdock codemod 0.5` rewrites `await createPermDock(…)` from `permdock` to `await loadPermDock(…)` and renames `createPermDock` from `permdock/pdp` to `loadPermDock`. A core `createPermDock(…)` that is returned or chained with `.then` is listed as a manual follow-up.
