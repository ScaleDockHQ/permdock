---
"permdock": minor
---

Export `coveredByDelegation(permission, delegation, resourceId?, hasActor?)` from `permdock`: the delegation coverage check `decide` uses for OAuth `scopes`, RFC 9396 `authorizationDetails` and GNAP `access`. It returns `undefined` when covered, otherwise `no-delegation` or `not-delegated`, and `permission` needs only `scope`, `resource` and `action`, so an external PDP such as the PermDock Cloud AuthZEN endpoint can reuse it.
