---
"permdock": minor
---

Breaking: `approve`, `reject`, `cancel`, `send`, `withdraw`, `confirm`, `fulfill`, `receive`, `reimburse` and `writeOff` compile as `update`, `remove` as `delete` and `duplicate` as `insert`. `mark*`, `pause*` and `resume*` compile as `update`. An `rls.actions` entry still wins, so `remove: "none"` stays.
