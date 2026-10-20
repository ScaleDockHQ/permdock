---
"permdock": patch
---

A custom-role grant with a `level` its resource does not declare still allows nothing. It now reports `schema` with an `unknown-level` cause on `on('auth')`, and `explain()` lists it in `trace.skipped` with `why: "unknown-level"` and the `level`.
