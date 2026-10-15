---
"permdock": patch
---

`permdock rls import` reads the `where` of a membership subquery instead of dropping it. A subquery over a mapped membership table imports as `memberOf` only when it binds the user and the policy row, and its role literals become `roles`, so `exists (select 1 from org_members m where … and m.role = 'owner')` imports as owners, not as every member. A subquery with any other predicate stays `opaque`.
