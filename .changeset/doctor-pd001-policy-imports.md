---
"permdock": patch
---

`permdock doctor` PD001 now reports a client entry that imports the configured `policy` module, resolving each import from the importing file: relative paths, tsconfig `paths`, and package names through `node_modules` and the package's `exports`, so a workspace package that exports the policy (`@acme/access/permdock/policy`) is followed to the policy file. Type-only imports are not reported.
