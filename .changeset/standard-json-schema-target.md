---
'permdock': patch
---

The catalog, `permdock rls` and `permdock doctor` now call Standard JSON Schema's `jsonSchema.output` with `{ target: 'draft-2020-12' }`, as the spec requires, instead of with no options.
