---
'permdock': patch
---

`permdock collect` and `permdock doctor` no longer crash with `Cannot read properties of null` on a source file with array holes (`const [, , id] = parts`). Doctor PD010 and PD014 ignore comments, and PD014 no longer reads a `const jwks: JSONWebKeySet` declaration as a `jwks` option without an issuer.
