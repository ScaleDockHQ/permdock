---
'permdock': minor
---

Verify Web Bot Auth (RFC 9421) in the Fetch kernel. A claimed signature that fails is rejected with `invalid-signature`; a verified signer becomes `actor.kind: 'web-bot-auth'`.
