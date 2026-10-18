---
"permdock": patch
---

`permdock codemod 0.5` wraps an `approvalPolicies` source in `approvalPolicies(…)` and a `policies` source in `hostedPolicies(…)` where the options object goes straight to `createPermDock`, `getPermDock` or `getPermDockSync`, and lists other `approvalPolicies` keys as manual follow-ups.
