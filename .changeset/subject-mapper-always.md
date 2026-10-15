---
"permdock": major
---

`createPermDock(policy, user)` always runs the policy's `subject` mapper on `user`. Before, a user object with an `id` and a `roles` or `memberships` array was taken as an already-mapped principal and skipped the mapper, so a mapper that narrows roles (for example, no roles until an email is verified) did not apply. A resolved `Subject` (`{ principal, context }`, as `subjectFrom*` helpers return) is still taken as is.
