---
"permdock": minor
---

`decide`, `can`, `assert` and `filter` take a `scope` option naming a declared scope: only memberships of that scope answer the check, global roles still apply, and any other membership is skipped with `scope`. Use `{ scope: 'organization' }` for a staff guard on a collection action (`quote.list`), which by default also passes through a nested membership such as a customer contact's. The default is unchanged. Snapshot instances apply the option too.
