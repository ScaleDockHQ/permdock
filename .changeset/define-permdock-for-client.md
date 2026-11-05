---
"permdock": minor
---

`definePermDock` takes `sources: (client) => { memberships?, customRoles?, subjects? }` and adds `app.forClient(client)`, a definition bound to that client with its sources cached in a `WeakMap`. `forClient` throws a `TypeError` that names `sources` when the option is missing.
