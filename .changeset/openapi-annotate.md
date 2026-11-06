---
"permdock": minor
---

`permdock openapi annotate --routes` reads `@permission`, `@permissionCheck` and `@oauthScopes` from route handlers and writes the operations map. `operationPermissionsFromOpenApi` reads `x-authorization` and `x-oauth-scopes`; emission still writes `x-permdock-*` and `security`. `permdock generate --only openapi` emits the map when the plugin sets `routes`.
