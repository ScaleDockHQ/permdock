---
"permdock": patch
---

A `401` to a request without an `Authorization` header now carries a bare `Bearer` challenge instead of `error="invalid_token"` (RFC 6750 section 3.1), and a rejected token gets a fixed `error_description`. The `/unauthenticated` body no longer carries `denials` or `alternatives`, so nothing explains the failure to an unauthenticated caller. `problemFromDecision` takes a `credentials` option for the challenge.
