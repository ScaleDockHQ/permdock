---
'permdock': patch
---

Fail-closed fixes found by the coverage suite:

- `subjectFromJwt` with `actor: { kind }` and no `from` now reads the RFC 8693 `act` claim. Before, a delegated token under that config resolved as the user acting directly, with no actor and so no delegation check.
- A custom `verifier.verify` that throws in `subjectFromJwt`, `subjectFromCapability` or `subjectFromCiOidc` resolves the anonymous subject with cause `malformed` instead of rejecting.
- `permdock/pdp`: a `provider.decide` that throws or rejects is `denied` with `pdp-unavailable`, and a `permitted` callback that throws makes `filter` and `where` keep no rows.
