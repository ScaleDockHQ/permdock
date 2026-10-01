---
'permdock': patch
---

`receiver.poll` reports polled SETs that can never verify under RFC 8936 `setErrs` in the acknowledgement request, so a transmitter stops redelivering them. A SET whose handler failed is still left pending for redelivery.
