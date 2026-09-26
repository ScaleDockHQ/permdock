---
'permdock': patch
---

`approvalsHandler`'s `GET /pending` now lists only the requests the caller may resolve, as documented: a requester no longer sees their own request when a distinct approver is required, the actor that raised a request no longer sees it, and requests reserved for other roles are hidden. `approve` already refused these.
