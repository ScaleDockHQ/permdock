---
"permdock": patch
---

`approvalsHandler` shows `GET /:token` for a request without a tenant only to its requester, who answered it and who may answer it; other principals get `404`. A note over 2000 characters is a `400` and a body over 16 KiB a `413`; the request stays pending.
