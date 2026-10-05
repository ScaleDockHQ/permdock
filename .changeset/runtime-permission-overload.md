---
"permdock": patch
---

`can`, `decide`, `assert` and `explain` accept a permission typed as plain `Permission`, such as one from `listPermissions` or `findPermission`, when the call passes `data` (`undefined` for a check without a row). Apps no longer cast the instance's methods to call them with a permission chosen at run time; literal references keep their narrower overloads, so an instance action without a row still fails to compile.
