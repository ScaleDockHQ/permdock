---
"permdock": minor
---

`problemDetails` in `permdock/openapi` is a Standard Schema, with a JSON Schema, for the Problem Details body of a denial. When an oRPC contract declares `oc.errors({ FORBIDDEN: { data: problemDetails } })`, `protect` from `permdock/orpc` throws through that constructor, so clients receive a defined, typed error.
