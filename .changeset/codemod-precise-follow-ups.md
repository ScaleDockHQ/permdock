---
"permdock": patch
---

`permdock codemod 0.5` reports `subjectFromApiKey` only in the old curried shape, `subjectFromApiKey(options)(key)`, and leaves `subjectFromApiKey(key, options)` alone. It reports a `source` option key only on an object passed to a PermDock call, not on every object literal in a file that imports `permdock`.
