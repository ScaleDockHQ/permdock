---
"permdock": minor
---

`permdock rls generate` suggests indexes only for the columns its policies and helpers look rows up by: scope keys, condition fields compared with the subject, a claim or a membership, and membership user columns. It no longer suggests indexes for comparisons with constants such as `status: 'sent'`, so the `indexes` part and `rls verify --introspect` warnings lose those entries. With the new `--db $DATABASE_URL` flag, `generate` also leaves out an index an existing index already leads with, and one whose table or column the database lacks, with a warning.
