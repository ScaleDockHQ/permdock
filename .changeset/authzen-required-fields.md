---
"permdock": minor
---

`permdock/authzen` answers `400` for a request without `Content-Type: application/json` and for a missing required entity or field, as AuthZEN 1.0 sections 10.1 and 10.1.1 require. Before, an evaluation without `subject`, `action` or `resource` answered `200` with `decision: false`, and an action search without a `resource` listed actions across every resource type. A numeric `resource.id` is now refused: the specification types it as a string.
