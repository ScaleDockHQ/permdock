---
"permdock": patch
---

`joseTokenVerifier` decrypts a nested JWE with any key in `decryptionKeys`, not only the first `oct` key. It accepts `RSA`, `EC` and `OKP` private JWKs, skips keys whose `use`, `alg` or `kid` do not fit the header, and tries the rest in order, so key rotation works.
