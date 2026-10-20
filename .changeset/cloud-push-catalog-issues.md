---
"permdock": minor
---

`permdock cloud push`, with or without `--dry-run`, checks the built catalog before it sends anything and prints every issue as `path: message`. With `--json` the error is a `catalog_invalid` Problem with `issues`; the exit code is 1.
