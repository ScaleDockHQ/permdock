---
"permdock": minor
---

New `permdock/delivery` entry. Its `createPermDock` returns a `DeliveryPermDock` whose `deliver` checks every recipient with `decideFor`, routes it to the email, chat or webhook transport, and writes one `com.permdock.delivery.*` event per recipient. It also adds `audience`, `subscribersFor`, `approvalPrompt` (ApprovalPrompt v1, with no token), `webhookTransport` (Standard Webhooks, CloudEvents) and `memoryDeliveryTransport`; `permdock/testing` adds `testDeliveryTransport`.
