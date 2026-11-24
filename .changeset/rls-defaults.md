---
"permdock": minor
---

`rls generate` compiles a verb with no `rls.actions` entry and no inferred command to `none` instead of failing; doctor `PD122` lists those verbs. A resource without an `rls.tables` entry binds to its snake_case plural table when only that one exists in the schema files, a scope without `rls.scopeTypes` takes its table's `id` type, and doctor `PD134` lists a resource whose table neither name finds.
