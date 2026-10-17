---
"permdock": patch
---

`permdock doctor` PD014 no longer reports the `jwks` option of `cloudApprovalWaiter`, `verifyWebhook` and `webhookVerifier`: it holds Standard Webhooks keys, not a token issuer's.
