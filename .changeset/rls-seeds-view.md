---
"permdock": minor
---

`rls.seeds: 'view'` writes `<schema>.role_permissions` as a `security_invoker` view over the compiled rows, so a declarative schema carries the rows and needs no seeds migration or `seed()` call.
