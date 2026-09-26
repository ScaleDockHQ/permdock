---
'permdock': patch
---

Fix in-memory condition comparisons coercing strings through `Date.parse`: ids such as `'user-2'` and `'2'`, or `'acme-1'` and `'globex-1'`, compared as equal instants, and a string could equal a number. Instants are now used only when one side is a `Date` or a `{ date }` literal, with strict ISO 8601 parsing; everything else compares same-type primitives only, matching SQL.
