---
"permdock": minor
---

`permdock openapi annotate --routes --write-spec <file>` writes `x-authorization` and `x-oauth-scopes` from route comments into an existing OpenAPI document. `x-authorization: "handler"` now marks a handler-checked operation instead of naming a permission key `handler`.
