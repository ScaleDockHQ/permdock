---
"permdock": minor
---

`com.permdock.automation.published`, `.changed`, `.revoked` and `.run` are no longer reserved: `automationEvent` builds the new `automation` sink event, published as `automation-event-v1.json`, and `WorkflowPermDock.start` writes a `run` event to `sink`. `supportSessionEvent` builds the `access` event of a support session, which gains optional `session` and `permissions` fields.
