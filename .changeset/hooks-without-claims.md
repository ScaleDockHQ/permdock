---
"permdock": minor
---

`authorizationHooks` takes `claims` as an optional option. Without it the hooks omit `automation`, `support` and `tickets`, and passing `service`, `support` or `tickets` without `claims` is a type error.
