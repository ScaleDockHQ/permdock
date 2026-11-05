---
"permdock": minor
---

`authorizationHooks` installs `delegation` only when you pass `delegation: true` or `delegation: { permissions }`, and `authorizationHooks({ policy })` returns `{ apiVersion, name, sessionTags }`. **Breaking:** an app that relied on the implicit delegation hook adds `delegation: true`.
