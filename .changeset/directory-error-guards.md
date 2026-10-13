---
"permdock": minor
---

`permdock/scim` exports `isDirectoryUniquenessError` and `isDirectoryNotFoundError`. Both match by `name` and `code`, so a custom `DirectoryStore` that throws the error from another copy of the module still maps to `409` or `404`.
