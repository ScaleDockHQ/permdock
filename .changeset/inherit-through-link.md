---
"permdock": minor
---

`inherit(permission, { through })` is a grantee that holds on a row when the subject holds `permission` on the row a link list or the parent points to: `allow(node.read, { to: inherit(drive.read, { through: ['drive'] }) })` makes a node readable wherever its drive is, by any grant of `drive.read`. In process the instance reads the target row through the new optional `RelationSource.row` (implemented by `memoryRelations`) and decides it with the full policy; a source without `row` denies with `relation-unavailable`. `permdock rls generate` compiles it to a check against the target's `permitted_<resource>_rows`, which it now writes for every targeted resource. `definePolicy` rejects it on a deny, on a collection action, for an unreachable or undeclared target and for a cycle. `testRelationSource` checks `row` when a source has it.
