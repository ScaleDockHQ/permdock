---
"permdock": minor
---

An `rls.memberships` table mapping takes a constant membership kind: `via: { value: 'staff' }` gives every row that kind, the way `fromJunction`'s `via` does, so a staff table needs no kind column (or a generated column) for roles with `for: ['staff']` to grant anything. The helpers, the `exists` checks of `memberOf`, the ownership triggers and `permdock_can_assign` read the constant, and the hook manifest describes it as `via: { value }`. `via: '<column>'` keeps naming a column.
