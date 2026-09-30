---
'permdock': minor
---

Relationship graph additions. An edge relation takes `match` (fixed column values, so one table with a `role` column serves several relations) and `groups` (a row may name a group whose members hold the relation, nested at most 16 deep per resource), and any relation may list `includes`, the relations that imply it. A resource declares `links`, named to-one references, and `relation(resource, name, { through: ['folder', 'team'] })` follows them. A resource role on a self-parented resource reaches the instances below it when a `relations` source is present. `RelationHolder` gains a `group` variant, `RelationSource.ancestors` takes a link name as `through`, `whoCan` reports group shares and implied relations, and RLS compiles all four through the `permitted_<resource>_ids` helpers and new `permdock_link_<resource>_<link>` helpers.
