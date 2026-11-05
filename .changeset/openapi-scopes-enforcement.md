---
"permdock": minor
---

`operationPermissionsFromOpenApi` reads OAuth scopes from `security` and the new `x-permdock-enforcement: "kernel" | "handler"`, and exposes `kernel` and `handler` maps. **Behaviour change:** an operation with OAuth scopes and no `x-permdock-permissions` becomes a scope-only entry where it used to be skipped as `no-permission`, an operation's `security` scopes now reach `oauthScopes`, and `security: []` is skipped with the new cause `public`. `permdock doctor` PD091 gains `openapi.enforcement: "kernel"`.
