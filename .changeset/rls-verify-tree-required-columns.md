---
"permdock": patch
---

`permdock rls verify --tree` fills the required columns its generated rows leave out, so it runs on tables with a `NOT NULL` tenant column or name: a foreign-key column takes an existing value of the referenced table, any other column a placeholder of its type. Before, the seed failed on any such table.
