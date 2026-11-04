---
"permdock": minor
---

`protectAction` from `permdock/next` takes `args`, a tuple of Standard Schemas for leading arguments, and the applied wrapper takes `{ after, result }`. `tenant` and `data` receive `(input, args)`, and the handler context gains `args`.
