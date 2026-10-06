---
"permdock": patch
---

`operationPermissions` matches a `HEAD` request to the `GET` entry of its path when no `HEAD` entry matches, so `protect(null)` and a permission gate no longer fail on the `HEAD` requests a framework such as Next.js serves with the `GET` handler. A declared `HEAD` entry still wins.
