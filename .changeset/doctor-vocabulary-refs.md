---
'permdock': patch
---

`permdock doctor` PD002 and `permdock collect` no longer report valid code as unknown permission references. The false positives were role and plan vocabulary (`role(roles.admin, …)`, `plan(plans.pro)`), a leaf's wire fields (`permissions.post.read.scope`, `.key`) and a resource subtree (`relation(permissions.post)`, `include: [permissions.post]`).
