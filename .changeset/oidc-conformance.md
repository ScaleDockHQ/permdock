---
'permdock': patch
---

`permdock/jwt` follows OpenID Connect more closely. Discovery never fetches an `http:` `jwks_uri`, and an inline `metadata.jwks_uri` over `http:` is a configuration error. With `accept: 'id-token'`, an ID token needs `iat`, needs `azp` when it has several audiences, and its `azp` must be the client id whenever present. The OpenID Connect Core section 5.1 profile claims (`email`, `name`, `picture` and the rest) no longer reach `principal.claims`. `claims.memberships` now flattens Zitadel's `role -> { orgId: domain }` project roles into one membership per organisation.
