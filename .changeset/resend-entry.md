---
"permdock": minor
---

New `permdock/resend` entry, with `resend` 6 as an optional peer. `resendTransport` is the email transport of `permdock/delivery`: it maps Resend errors to retryable or final failures and fans out through `batch.send`. `approvalEmail` renders an approval prompt that only links to the approval page. `resendWebhook` turns delivered, bounced, complained, failed and suppressed events into delivery events.
