---
"permdock": patch
---

`permdock.filter()` no longer builds a decision token, freezes a decision or computes alternatives for each row it drops or keeps. Filtering 1,000 rows takes about a quarter of the time it did (`pnpm bench`).
