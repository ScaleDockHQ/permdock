---
"permdock": minor
---

A verb missing from `rls.actions` compiles to `'none'` without a warning, so `rls.actions` lists only the verbs that map to a SQL command; the generated SQL is unchanged. New `permdock doctor` check PD071 reports an unmapped verb whose name reads as a write (`create…`, `update…`, `approve…`, `markPaid`, `writeOff`), so you map it on purpose.
