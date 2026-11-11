---
"permdock": patch
---

PD072, PD064, PD090, PD115 and the plan checks expand a `{part}` in `rls.out` to each split part before they read it, so a guard trigger in the helpers part of `rls({ out: "db/{part}.sql" })` no longer reports PD072. PD111 accepts an optional `limit` with a `default` and a `maximum`, as its fix text says.
