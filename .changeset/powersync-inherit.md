---
"permdock": minor
---

`permdock powersync generate` compiles an `inherit()` grant into `<field> IN (SELECT <parent id> FROM <parent> WHERE …)`, one query per query of the parent's read grants and one nested subquery per link hop, instead of leaving the grant out. `powersync verify` notes a row an `inherit()` stream syncs rather than failing on it.
