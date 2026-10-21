---
"permdock": minor
---

`rls.tables.<resource>: false` marks a resource with no table: `permdock rls generate` writes no policies or SELECT coverage for it and still seeds its role grants, and `rls verify` skips its fixtures. Without `--db-url-stdin`, `rls generate` also warns for each bound table that no `create table` in the project's migration or schema folders creates.
