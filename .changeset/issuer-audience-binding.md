---
"permdock": minor
---

Tokens are bound to their issuer and audience. `subjectFromJwt` requires `issuer` with any remote `jwks` (a URL as well as a key set). `joseTokenVerifier` and `permdock/ssf` take the issuer from `discovery` when none is set and check every token against it. `subjectFromIntrospection` requires `aud` to contain the configured `audience`, rejects a differing `iss`, and no longer fills `principal.issuer` from the options. `scimHandler` no longer derives the audience from the request URL and throws when `verifier` is set without `audience`.
