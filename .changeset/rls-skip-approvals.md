---
"permdock": patch
---

`permdock rls generate` skips every grant that requires an approval. It skipped only `approval: 'human'`, so an `approval: { by }` grant compiled into a plain policy and the database allowed the action without the approval.
