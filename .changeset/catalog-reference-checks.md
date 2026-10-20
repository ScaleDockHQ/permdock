---
"permdock": minor
---

`parseCatalog` now rejects a role `on` an undeclared scope, an operation, grant, delegation or OAuth scope that names an undeclared permission key, and duplicate keys, with every issue's `path`. `parseCatalog(json, { requireMeta: ['title', 'risk', 'effects'] })` also requires those permission `meta` fields.
