---
"permdock": minor
---

A `user` credential may name a `tenant`, which holds a personal key to one tenant of its owner. `parseCredential` accepts it (it was rejected before), `decideCredential` takes `tenant` on a user request and refuses one the creator is not a member of with `exceeds-creator`, and the tenant's `credentials` settings govern the key. `createPermDock` makes the key's tenant the active tenant, keeps only the owner's memberships inside it and drops the owner's global roles, whether the memberships come from `owner`, the token or a `memberships` source, so `can()`, `decide()`, `where()`, snapshots and `tenants()` answer for that tenant only. `rls.apiKeys` already holds a key whose claim names a tenant to it in SQL; a verifier copies the credential's `tenant` into that claim. `ids` still holds resource ids only.
