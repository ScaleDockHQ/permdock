---
"permdock": minor
---

The `PermDock-Approver` token `cloud().approvals.resolve` sends is now bound to one verdict: it carries a `permdock_approval` `authorization_details` entry with the request `id`, the verdict `status` and, when the Cloud sends one, the request `etag`, plus a fresh `jti`. `resolve` reads the request through `GET /approvals/by-token` before it signs, and throws the Cloud's code (`approval-not-found` by default) when that read fails.
