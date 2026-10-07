---
"permdock": patch
---

`usePermission`, `usePermissions` and `useApproval` from `permdock/react` and `permdock/react-native` now update after a snapshot change when the React Compiler compiles them. Before, a compiled hook kept its first answer, such as `pending`.
