# @permdock/testing

## 0.1.0-next.0

### Minor Changes

- 8bfa791: `cloud().policies.refresh()` verifies the `permdock-policy+jwt` against the Cloud environment URL (`iss` and `aud` are `<PERMDOCK_CLOUD_URL>/v1/environments/<env>`; `exp` is 24 hours after issue). The `audience` option is removed. `cloud()` exposes the environment URL as `issuer`, `jwks` is the environment's JWK Set URL, and `cloudEndpoints()` resolves both without a key. The policy JWS fixture in `@permdock/testing` follows the new claims.
- 223abdb: First release of PermDock: typed, portable permissions for apps, APIs and agents, with the `permdock` core and adapters, the `@permdock/cli` build tooling and the `@permdock/testing` runners.
