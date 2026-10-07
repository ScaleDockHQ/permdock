---
"permdock": minor
---

Edge `groups` accept a subject column per group: `groups: { resources: { team: { relation: 'member', subject: 'team_id' } } }`. Share tables that keep each subject kind in its own typed column (`user_id uuid`, `team_id bigint`) no longer need one subject column plus a kind column. Without `column`, a row names the principal when the edge's `subject` is not null and a group when that group's column is not null. `memoryRelations`, the `where()` compilers and `permdock rls generate` all read the new form, and the `EdgeGroup` type is exported. A plain relation name per group still works and still needs `column`.
