---
'permdock': minor
---

Doctor PD028 now also warns when the migrations let `anon` or `authenticated` insert or update a column that decides a membership: the user, scope, id, `within`, role, `via` and expiry columns of every `fromTable` / `fromJunction` source. A contact who can edit their own row could otherwise set `user_id` or `customer_id` and give themselves a membership. The grant model matches Postgres, where a column-level `revoke` leaves a table-level grant in place. `MembershipSql` gains `columns`, the list the check reads.
