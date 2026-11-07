---
"permdock": minor
---

Breaking: `permdock_<resource>_chain()` starts at the caller's own row, the row whose `rls.tables.<resource>.user` column (the id column by default) is the caller, and returns every row below it in that row's tenant. It no longer treats the parent column as a user id. A path guard and a depth cap of 32 end a cycle or a self-parented row, and an active cover adds the delegator's row and every row below it.
