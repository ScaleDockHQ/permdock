---
'permdock': patch
---

Fail-closed fixes for a grantee kind this build does not know, as a forged snapshot or a newer policy document could carry:

- An allow naming one matched every caller, anonymous included; it now matches nobody, on the server, in `fromSnapshot` and for approvers.
- A deny naming one now applies to everyone.
- A hosted grant naming one is dropped as `unknown-grantee`, and an approver `by` naming one is invalid.
- `whoCan` reports `complete: false` when it meets one.
- `toOcsf` maps an outcome this build does not know to `status_id` 0 `Unknown` instead of leaving `status_id` and `status` undefined.
