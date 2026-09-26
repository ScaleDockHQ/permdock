---
'permdock': patch
---

`permdock/jwt` and `permdock/ssf`: `joseTokenVerifier` accepts a Security Event Token (`typ: secevent+jwt`) without `exp`, as RFC 8417 allows, and requires `iat` on it instead. Before, the SSF receiver configured with `jwks` or `discovery` rejected such SETs as `malformed`. Every other token type still requires `exp`, including Back-Channel Logout tokens.
