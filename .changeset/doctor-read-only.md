---
"permdock": patch
---

`permdock doctor` without `--fix` and `permdock usage` no longer write `permissions.catalog.json`. PD002, PD044 and `usage` scanned the sources through a full `collect`, which wrote or refreshed the catalog as a side effect, so a doctor run in CI left a changed file behind. They now scan in memory, as the `usage` page already said.
