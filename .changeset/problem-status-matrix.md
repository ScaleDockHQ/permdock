---
"permdock": minor
---

Breaking: a thrown `assert` now answers with the status `protect` sends for the same decision. `toProblemDetails()` and `problemFromError()` return 401 for no subject or a missing step-up, 404 for a row of a `disclosure: 'hide'` resource, 429 with the `RateLimit` fields for an exhausted limit and 503 for an unavailable limit store, where they returned 403. `problemFromError(error, { credentials })` picks the `401` challenge. The AuthZEN and approvals 401s carry `WWW-Authenticate`, Nest's missing-row 404 and the Supabase middleware's 405 carry Problem Details, and Convex maps `PermDockValidationError`.
