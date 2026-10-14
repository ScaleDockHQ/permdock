---
"permdock": minor
---

A decision made under a support session carries `subject.supportSession: { id }`, the id its `access` events carry as `session.id`, and `permdock/otel` maps it to `permdock.support_session.id`. `decision-event-v1.json` accepts the new optional field.
