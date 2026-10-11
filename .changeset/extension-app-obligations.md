---
"permdock": minor
---

`allow(p, { obligations })` adds `{ kind: 'app', name, detail? }` obligations to a granted decision, in process and through snapshots, and decision events, OCSF and OTel carry the grant `name` and the obligation names. A denied decision now carries `permission`, `DenialDetails` types each reason's `detail`, and `describe(decision, { permission })` uses the leaf's `meta.title`.
