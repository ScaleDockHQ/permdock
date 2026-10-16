---
"permdock": minor
---

Request bodies are read up to a byte cap and answered with `413` past it, whatever `Content-Length` says: 1 MiB for the AuthZEN endpoints, `evaluationsHandler`, `scimHandler`, the SSF receiver from `createReceiver` and `webhookVerifier`, 16 KiB for approval and access-review notes, 1,000,000 bytes for `resendWebhook`. Before, these handlers read the whole body first, and the Resend and approval caps counted characters.
