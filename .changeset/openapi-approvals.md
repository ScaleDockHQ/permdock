---
'permdock': patch
---

`permdock/openapi` marks an operation with `x-permdock-approval` (and the optional `x-badges` hint) for every grant that requires an approval. It marked only `approval: 'human'`, so `approval: { by }`, `{ distinct: false }` and `{ staleOn }` grants looked approval-free in the description.
