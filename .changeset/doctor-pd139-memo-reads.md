---
"permdock": patch
---

`permdock doctor` PD139 warns when a memoized helper reads a view, a function outside the helper schema, an `auth` table or a table without the `permdock_memo_generation` trigger, because a write there is not seen until the next statement. The generated SQL is unchanged from 0.35.1.
