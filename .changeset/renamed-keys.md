---
"permdock": patch
---

`definePermissions(tree, { renamed })` maps former permission keys to current ones: stored custom roles, OAuth scopes, AuthZEN actions, hosted grants and `findPermission` accept the old key, while decisions and audit see only the new one. The catalog lists `renamedFrom`, `permdock diff` reports `renamed` (not breaking) and `alias-removed` (breaking), `rls generate` seeds `role_permissions` under former keys too, `rls generate --shims` adds wrappers under legacy helper names, and `permdock doctor` PD055 and PD056 report what still uses an old key or helper.
