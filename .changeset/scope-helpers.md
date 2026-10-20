---
"permdock": minor
---

`permdock` exports `normalizeMembership`, `normalizeMemberships` and `resolveScope`, the membership normaliser and scope-alias lookup evaluation uses. Each takes `catalog.scopes` or a policy's scope list; absent means the implicit `tenant` and `team` pair.
