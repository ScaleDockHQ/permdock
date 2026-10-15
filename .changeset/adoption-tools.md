---
"permdock": minor
---

Tools to adopt PermDock in an existing app. `shadowMode({ legacy, enforce, onMismatch })` is a `wrap` that asks the application's legacy check and PermDock on every check, returns the legacy answer unless the permission is in `enforce`, and reports each disagreement. `testLegacyParity(policy, legacy, cases)` in `permdock/testing` pins the intended answers. `permdock scan --legacy` lists the role comparisons, `hasRole`/`hasPermission` helpers, CASL abilities, Clerk `has()` calls and role claims left in the code.

`wrapPermDock` now keeps the instance's internals, so feature functions (`whoCan`, `decideCredential`) work on an instance wrapped by an adapter's `wrap` or `withOtel`.
