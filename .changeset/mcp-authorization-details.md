---
'permdock': patch
---

`permdock/mcp`: `createPermDock` and `subjectFromMcp` now read RFC 9396 authorization details from both `authInfo.extra.authorizationDetails` and the raw claim name `authorization_details`. Before, each read only one of the two, so the same verifier output lost its details in one of them.
