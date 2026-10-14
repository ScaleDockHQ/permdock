---
"permdock": minor
---

`permdock/cloud` adds `cloudApprovalWaiter`, an `ApprovalWaiter` whose `webhook(request)` wakes parked runs on verified `com.permdock.approval.resolved`, `.expired` and `.cancelled` events. It also adds `cloudDeliveryTransport(channel)` for the Cloud's hosted sender, `cloudSigner()`, a `TokenSigner` over the environment key for run tickets and other app-issued tokens, and `cloud().catalog.push(catalog)`; `PermDockCloudEvent` now includes the automation and delivery families.
