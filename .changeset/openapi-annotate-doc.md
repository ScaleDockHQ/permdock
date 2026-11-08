---
"permdock": minor
---

`permdock openapi annotate --doc <file>` writes the operations map from an OpenAPI document: `operations` with `operationId`, `operationGroups` by first tag or path segment, and with `--tenant-path <param>` `operationTenants`. Each key is checked against `--permissions`; unknown, duplicate or missing keys exit `1` and write nothing.
