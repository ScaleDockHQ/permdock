---
"permdock": patch
---

`permdock codemod 0.5` rewrites `permdock.decideRoleChange(…)`, `decideCredential`, `decideAutomation`, `decideSupportSession`, `whoCan`, `activate` and the Arazzo form of `simulate` into the free functions that take the instance first, and imports them from `permdock`.
