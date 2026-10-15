---
"permdock": patch
---

Resuming an approval checks that the stored request belongs to the caller's principal, and a remote PDP answer of `approval-required` without a `token` now denies with `pdp-invalid-response`. Before, a remote PDP that omitted the token gave every caller the same empty token, so one approval could resume another subject's call.
