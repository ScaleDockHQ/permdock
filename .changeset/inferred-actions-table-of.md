---
"permdock": minor
---

`permdock rls generate` maps a compound action whose first word is a default verb (`updateStatus`, `list_archived`) to that verb's SQL command, and `rls explain` lists each inferred action. `rls.tables.<resource>: { tableOf: '<owner>' }` stores a resource in its owner's table; the owner writes the policies. `doctor.sharedTables` is removed: declare the shared resource with `tableOf`, which `PD075` skips.

| Old                                         | New                                                                                    |
| ------------------------------------------- | -------------------------------------------------------------------------------------- |
| `doctor.sharedTables: ['public.documents']` | `rls.tables.<resource>: { tableOf: '<owner>' }` on each resource that shares the table |
