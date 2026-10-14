---
"permdock": minor
---

`cloud({ approver: { signer, audience? } })` signs a `PermDock-Approver` header for each `approvals.resolve`: an RFC 9068 `at+jwt` with `sub` set to the approver's principal id, `aud` set to `<environment URL>/approvals` and a 60-second lifetime. `resolve` now throws `approver-unauthenticated` without a signer and `approver-not-eligible` for a verdict with an actor; a system rejection needs no signer. `TokenSigner` accepts `typ: "at+jwt"`, which `cloudSigner` refuses.
