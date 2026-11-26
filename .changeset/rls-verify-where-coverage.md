---
"permdock": patch
---

`permdock rls verify --introspect --helpers-only` accepts a helper call for a permission whose row conditions are string equalities or a scope relation, when the policy `and`s each equality with that call and calls `member_<scope>_ids` for each relation.
