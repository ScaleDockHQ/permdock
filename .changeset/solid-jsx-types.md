---
'permdock': patch
---

`permdock/solid`: `PermDockProvider` and `Protected` are typed as returning `JSX.Element`, so `<PermDockProvider>` and `<Protected>` typecheck in TSX (they returned `unknown` and an accessor type, which TypeScript rejected as JSX components).
