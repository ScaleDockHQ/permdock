---
"permdock": minor
---

`permdock/catalog` exports `checkHostedGrant(policy, grant)`, which answers `{ ok: true }` or the `HostedGrantDropReason` `mergeHostedGrants` would report for one candidate hosted grant, without a `PolicyDocument`.
