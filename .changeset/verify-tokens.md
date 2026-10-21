---
"permdock": minor
---

`permdock/jwt` adds `verifySubjectToken(token, { verifiers, audience, replay, maxLifetime })`, which accepts an `at+jwt` from the first matching verifier, at most 300 seconds long by default and with a `jti` used once (causes `lifetime-exceeded` and `replayed`), and `verifyIdToken(token, { issuer, clientId, nonce, verifier })`, the relying party's ID token check with `nonce-mismatch`.
