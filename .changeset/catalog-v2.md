---
"permdock": minor
---

Breaking: the catalog wire format is `catalog-v2.json` with `version: 2`. A stored approval that still uses `mode: any|all|sequential` or a boolean `distinct` fails closed. `permdock codemod 0.26` rewrites a stored catalog-v1 document.
