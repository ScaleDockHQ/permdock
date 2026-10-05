---
"permdock": minor
---

`permdock/openapi` exports `operationPermissions(operations, { base? })`, one declaration of each API operation's permission as `"METHOD /path/{param}"` to a permission (or `{ permission, operationId }`), with `forRequest(method, path)` for an HTTP gate and `forOperation(id)` for `permdock/mcp`'s `permissionFor`, and `operationPermissionsFromOpenApi(document, permissions)`, which builds it from the `x-permdock-permissions` a description carries. REST routes and the MCP tools over them no longer need separate route tables that can drift apart.
