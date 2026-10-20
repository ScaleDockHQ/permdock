---
"permdock": minor
---

`permdock.decideIds(permission, ids, { data })` decides ids the server loads through `data(ids)`, each row in the tenant its own scope field names, and returns a `Decision[]` in id order. An id with no row denies with `validation`; a snapshot instance denies with `unsupported`.
