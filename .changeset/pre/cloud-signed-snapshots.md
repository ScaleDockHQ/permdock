---
"permdock": minor
---

`cloud().snapshots.get()` requests `application/jwt` and returns only a compact `permdock-snapshot+jwt`; an unsigned snapshot body now throws instead of being parsed.
