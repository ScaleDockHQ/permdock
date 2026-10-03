---
"permdock": patch
---

`sender: 'dpop'` (the `profile: 'fapi2'` default) now resolves the anonymous subject with `dpop-proof-invalid` when no `Request` is passed, instead of skipping the proof. `verifyDpopProof` refuses a symmetric `alg` and a `jwk` header carrying private key members, per RFC 9449 section 4.3.
