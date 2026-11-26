---
"permdock": patch
---

The generated `permdock_token_current()` accepts the compact `memberships` object the hook writes as well as the older array, so the claims-first helpers take the token again instead of always reading the database. Rerun `permdock rls generate`.
