---
"permdock": patch
---

The SSF push receiver answers a request that is not a `POST` with `405 Method Not Allowed` and `Allow: POST`, instead of `400 invalid_request`.
