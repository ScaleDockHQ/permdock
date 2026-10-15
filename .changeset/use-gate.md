---
"permdock": minor
---

`useGate(permission, data?, { mode })` in `permdock/react` and `permdock/react-native` returns what a permission-gated control renders: `allowed`, `pending`, `hidden`, `disabled`, `needsApproval`, `upgrade` (the plans that would grant it) and a localised `reason`. `gateView` in `permdock/client` is the same computation without React.
