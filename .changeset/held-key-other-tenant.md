---
"permdock": patch
---

A `createPermDock` instance asked for a tenant other than the one a user key is held to now answers for no tenant: it keeps none of the owner's memberships, reads no entitlements and denies every check, so `protect()`, `can()`, `where()`, snapshots and `tenants()` agree. Before, the key's tenant took precedence over the requested one, and a route of tenant T granted a permission the owner held in the key's tenant. This covers every adapter, the MCP and agent entries and the remote PDP, which all resolve the tenant through `createPermDock`.
