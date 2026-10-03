---
"permdock": patch
---

OpenAPI output now matches the documented shapes:

- `scheme.deprecated` emits `deprecated` on 3.2 and 3.3 and `x-oai-deprecated` on 3.1.
- On 3.1 the device flow sits inside `flows` as `x-oai-deviceAuthorization`, with the flow's own URL as `x-oai-deviceAuthorizationUrl`.
- A permission granted unconditionally to `anyone()` gets `security: []`.
- Top-level grants now reach `x-permdock-conditions` and `x-permdock-approval`.
- The 3.3 profile scheme carries `supportedParametersSchema` as a URL and named `servers`. `securityProfileRequirements(scopeSets?)` writes one requirement per distinct scope set, each with `securityScheme`, `token_endpoint_auth_methods`, `grant_types` and `scopes`.
- `permdock openapi emit --target 3.3` writes `openapi: 3.3.0` and validates the result against a patch of the 3.2 schema keyed by the draft pin. `permdock openapi import` accepts 3.3 documents.
