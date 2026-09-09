---
'permdock': minor
'@permdock/testing': patch
---

Evaluate GNAP `delegation.access` against grants, map RFC 7662 / RFC 9767 introspection in `subjectFromIntrospection`, and reject a claimed `act` nest that does not verify (`invalid-chain`).
