---
"permdock": minor
---

`permdock/next` taints its options and each instance when React exposes `experimental_taintObjectReference`, and `createNextConfig()` sets `experimental.taint`. `getSnapshot({ context })` and `<PermDockProvider context>` keep only the named `subject.context` keys. `evaluator="lazy"` on the Next provider renders the lazy-evaluator provider. `getSnapshot` warns once in development under 30 seconds as well as under 300, and an uncached `PermDockProvider` warns once. `permdock/react` adds `onlineRefresh()` for `useRefreshOn`.
