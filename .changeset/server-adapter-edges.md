---
'permdock': patch
---

Edge fixes found by the coverage suite:

- SCIM list paging starts at the first item for a negative or non-finite cursor; before, it sliced from the end and returned a negative `startIndex`.
- An SSF back-channel logout token with an empty `sub` and a `sid` maps to an opaque session subject, not an `iss_sub` subject with an empty `sub`.
- `PermDockCloudEvent` includes `dev.permdock.credential`, which `verifyWebhook` already accepted.
