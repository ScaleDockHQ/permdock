---
"permdock": minor
---

New `policyFromCatalog(catalog, pushed)` on `permdock/catalog` rebuilds an evaluable policy from `permissions.catalog.json` and the pushed policy, for a service with no application code; what only code can answer denies. `catalogDrift` and `hostedGrantFindings` compute the findings of `com.permdock.catalog.drifted`. The catalog now carries each resource's `parent`, its `links` and the vocabulary roles.
