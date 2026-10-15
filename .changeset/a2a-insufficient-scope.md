---
"permdock": patch
---

`permdock/a2a` answers a token that lacks a skill's scope with `403` and `WWW-Authenticate: Bearer error="insufficient_scope"`, as RFC 6750 section 3.1 requires. It answered `401`, which tells a client its token is missing or invalid.
