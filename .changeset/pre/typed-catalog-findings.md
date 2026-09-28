---
'permdock': minor
---

`dev.permdock.catalog` drift findings are typed `CatalogFinding` objects `{ code, permission, grant? }` with `code` one of `permission-removed`, `not-hostable`, `grantee-removed` or `approval-tightened`; `parseCloudEvent` and `verifyWebhook` reject the earlier free-text strings.
