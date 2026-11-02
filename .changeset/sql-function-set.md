---
"permdock": minor
---

Add the `sqlFunction` set variant: `sqlFunction(name, { args, set: { column }, twin })` renders `"<column>" in (select <name>(<args without row fields>))`, so a set-returning helper runs once per statement instead of once per row. The in-memory evaluator, `filter`, `where`, snapshots and `--inline-functions` still use the twin. `rls import` reads `col in (select fn(...))` and `col = any (select fn(...))` back as the same form, and doctor `PD086` checks the set column and warns when row-field args would be dropped.
