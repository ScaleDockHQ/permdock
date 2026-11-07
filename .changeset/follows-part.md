---
"permdock": minor
---

`rls generate --split` writes the `follows` part whenever `rls.tables.<resource>.follows` is set, to `<schemaDir>/permdock/follows.sql` under pg-delta and to `{part}` otherwise, with or without the `policies` part. The `policies` part no longer holds the child-table policies. PD101 warns when a schema file defines a permissive policy on a `follows` child table.
