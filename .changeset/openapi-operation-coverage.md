---
"permdock": minor
---

`operationPermissions(...)` from `permdock/openapi` gains `entries()`, `operationPermissionsFromOpenApi` gains `onSkip(operation, cause)`, and `testOperationCoverage` in `permdock/testing` fails on a tenant-path operation with no entry. `permdock doctor` runs the same check as PD091 from the new `openapi.operations`, `openapi.tenantPaths` and `openapi.base` config keys.
