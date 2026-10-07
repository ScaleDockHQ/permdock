---
"permdock": patch
---

`PermDockProvider` from `permdock/react` and `permdock/react-native` keeps its store when a re-render passes an inline `headers` object, `fetch` function or `verifier`. Before, every parent render rebuilt the store, dropped the refreshed snapshot and cached answers, and on React Native refetched the snapshot. `headers` compare by value; `fetch` and `verifier` call the latest prop.
