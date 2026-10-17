---
"permdock": minor
---

Breaking: the `permdock/cloud` client follows the settled Cloud contract (`schemas/cloud-api-v1.json`). For the PermDock-Cloud repository: the new `PermDock-Subject` header on `GET /v1/environments/:env/snapshot`, the `pushed-policy-v1`, `connector-v1`, `run-v1` and `support-session-v1` formats, and the approver token claims below.

| Before                                                                              | After                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud().snapshots`                                                                 | `cloud().snapshotsFor(token)`: a `SnapshotSource` for the subject an `at+jwt` proves, sent as `PermDock-Subject`                                                                                                                 |
| `cloud().catalog.push(catalog)` resolves to `{ fingerprint }`                       | `CloudCatalogPush`: `{ version, fingerprint, findings }`, or `{ version, fingerprint, unchanged: true }` when the fingerprint is already published                                                                               |
| The policy `permdock cloud push` sends: `{ fingerprint, scopes?, grants }`          | `PushedPolicy` with `v: 1`, from `permdock/catalog`, validated by `schemas/pushed-policy-v1.json`                                                                                                                                |
| Approver token: `sub` and a `permdock_approval` detail with `id`, `status`, `etag?` | Also `roles`, `memberships` and `tenant`; the detail adds `permissions`, `relations` and `vouched`. `cloud({ approver: { permissions?, relations? } })` reads them, typically from `approverPermissions` and `approverRelations` |
