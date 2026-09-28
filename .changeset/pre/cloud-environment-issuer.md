---
'permdock': minor
'@permdock/testing': minor
---

`cloud().policies.refresh()` verifies the `permdock-policy+jwt` against the Cloud environment URL (`iss` and `aud` are `<PERMDOCK_CLOUD_URL>/v1/environments/<env>`; `exp` is 24 hours after issue). The `audience` option is removed. `cloud()` exposes the environment URL as `issuer`, `jwks` is the environment's JWK Set URL, and `cloudEndpoints()` resolves both without a key. The policy JWS fixture in `@permdock/testing` follows the new claims.
