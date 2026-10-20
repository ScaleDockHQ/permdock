---
"permdock": minor
---

`permdock/approvals` exports `approvalEntityTag(request)` and `approvalView(request)`, the `ETag` `approvalsHandler` serves and the view it hashes (the request without `token`). `permdock` exports `canonicalJson` (RFC 8785) and `sha256Digest`, the two steps behind every `sha-256:` digest.
