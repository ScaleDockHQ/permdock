---
"permdock": minor
---

`authorizer(...).warm()`, `authorizationHooks(...).warm()` and `warm(policy)` from `permdock/next` build one anonymous instance and run one `can`, so the first request skips them. They never reject and answer `{ ok, ms }`.
