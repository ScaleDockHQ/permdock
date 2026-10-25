---
"permdock": minor
---

`powersync.tables` syncs tables that are not resources, such as a notification inbox or a file table: the user's own rows by a `user` column, and the rows that point at a resource row the user reads through `follow: [{ resource, field, match? }]`.
