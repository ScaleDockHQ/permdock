---
"permdock": patch
---

`permdock doctor` without `--fix` no longer writes `permissions.catalog.json`. PD002 scanned the sources through a full `collect`, which wrote or refreshed the catalog as a side effect, so a doctor run in CI left a changed file behind.
