---
"permdock": minor
---

`permdock rls generate` puts the `min`, `max` and `transferOnly` triggers on the tables of `fromTable` and `fromJunction` membership sources when a scope has no `rls.memberships` table, so a policy with ownership rules can keep its memberships in sources. One `permdock_holders_<scope>` and one `permdock_transfer_only_<scope>` function count holders over every source of the scope, and `MembershipSql.holders` (typed `MembershipHolders`) describes the rows they count. A source without `holders` still leaves the counts to `decideRoleChange`.
