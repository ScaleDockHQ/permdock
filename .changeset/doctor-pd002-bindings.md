---
"permdock": patch
---

`permdock doctor` PD002, `collect` and `usage` now resolve a reference's root identifier to its binding. A parameter, local variable or module variable named `permissions` (an array of strings, for example) is no longer read as a permission tree, so `permissions.length` is not reported as an unknown permission; an import of `permissions` or of any `definePermissions` export, and a `definePermissions` declaration, still are, in any file order.
