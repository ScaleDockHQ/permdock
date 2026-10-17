---
"permdock": minor
---

`signSnapshot(snapshot, signer, { audience? })`, `snapshotFromClaims` and `signPolicyDocument(document, signer, { audience, expiresAt? })` are exported from `permdock`, and `signApproval(request, signer, { audience? })`, `approvalSignatureClaims`, `parseApprovalRequest` and `APPROVAL_REQUEST_SCHEMA` from `permdock/approvals`. `schemas/run-v1.json` and `schemas/support-session-v1.json` describe the run ticket and support-session tokens.
