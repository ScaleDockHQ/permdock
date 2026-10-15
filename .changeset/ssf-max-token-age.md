---
"permdock": minor
---

The SSF receiver refuses a SET without `exp` once its `iat` is older than `maxTokenAge` (default 86400 seconds), and keeps each replay key until the SET would no longer verify. Before, with a `clockTolerance` above zero, a captured SET without `exp` could be delivered again after its replay key expired.
