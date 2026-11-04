---
"permdock": patch
---

`permdock/react` ships the snapshot evaluator in its entry again, so a provider with a synchronous `snapshot` answers every check on the first render and in a server render, as before 0.23.0: in 0.23.0, `usePermission(permission, data)`, `useDecision`, `useGate`, `usePermDock`, `useFilter` and `<Protected>` with row data suspended while the evaluator chunk loaded, even without `suspend`. `permdock/next` renders this provider. The on-demand evaluator moves to the new opt-in entry `permdock/react/lazy`, with the same exports: its hooks suspend until the chunk arrives and need a Suspense boundary. `saas client react` measures 21,184 B gzip; `permdock/react/lazy` measures 14,690 B initial and 21,708 B in total. The lazy entry's hooks also no longer throw React's conditional `use()` error when hydration retries after the chunk lands.
