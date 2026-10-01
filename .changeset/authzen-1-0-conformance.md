---
'permdock': patch
---

`permdock/authzen` follows more of AuthZEN 1.0:

- Every response echoes `X-Request-ID`.
- `/access/v1/evaluations` honours `options.evaluations_semantic`, and treats a request without an `evaluations` array as a single evaluation.
- Discovery under `/.well-known/authzen-configuration/<path>` names the path-qualified PDP identifier.
- Search accepts `page.limit` and returns `page.count` and `page.total`.
- Subject search answers only for the `user` subject type.
