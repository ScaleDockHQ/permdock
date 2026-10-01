---
'permdock': minor
---

New runtime entry `permdock/catalog`: `parseCatalog(json)` validates a `permissions.catalog.json` (text or parsed) against `schemas/catalog-v1.json` and returns a deep-frozen, prototype-safe copy, throwing `PermDockValidationError` with every issue; `rowConditionKeys(catalog)` lists the permissions marked `rowConditions: true`; the `Catalog*` types move here and stay exported from `permdock/cli`, with `CatalogDocument['version']` now `1`. `permdock/cli` exports `catalogPath(config, cwd, out?)`, the path `collect` writes to. `catalog-v1.json` now requires what `collect` always writes (`generatedAt`, `generator`, a permission's `meta` and `usages`, a resource's `id` and `schema`), types every field the catalog carries, and adds the missing `staleOn` on approvals; `permdock catalog --format schema` emits the same document.
