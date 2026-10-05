---
"permdock": minor
---

`securityFor(permission)` and `permissionsExtension(permissions)` in `permdock/openapi` return an operation's `security` and `x-permdock-permissions` from permission references alone, so a contract package can write them without importing the policy. `protect` from `permdock/orpc` now attaches to contract procedures that declare an `output`.
