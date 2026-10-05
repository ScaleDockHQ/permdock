---
"permdock": minor
---

A resource whose rows are the scope's instances, such as an `organizations` table whose own `id` is the organization id, can take scoped roles: its one `memberOf` relation to the scope (`{ self: { field: "id", memberOf: "organization" } }`) names the field when it is not the scope's `key`. `can`, `where()`, `whoCan`, snapshots and `rls generate` read that field; a snapshot's `scopes[]` entry carries it in the new optional `fields` map. `definePolicy` throws when a resource has several `memberOf` relations to a scope and none on its key.
