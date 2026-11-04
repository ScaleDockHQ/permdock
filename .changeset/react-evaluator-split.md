---
"permdock": minor
---

`permdock/react` loads its evaluator on demand: the initial download of `PermDockProvider` + `usePermission` drops from 20,263 B to 14,637 B gzip. Breaking: `usePermission(permission)` without `data` returns `{ allowed, status, outcome }` and no `decision`; use the new `useDecision(permission, data?)` for a `Decision`. `usePermission(permission, data)`, `useDecision`, `useGate` and `usePermDock` suspend while the evaluator chunk loads. `snapshot()` adds an optional `typeLevel` field (`{ granted, approval?, endpoint? }`), and server entries that call it grow by 0.1 to 1.8 KB gzip.
