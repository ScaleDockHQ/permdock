---
"permdock": minor
---

`CatalogFindingCode` adds `operation-risk-raised` and `operation-approval-removed`, and `CatalogFinding` gains `operation`, `previous` and `risk`. `operationFindings(previous, next)` in `permdock/catalog` computes them, `permdock diff` lists them under `operations` without marking them breaking, and `catalog-event-v1.json` accepts them.
