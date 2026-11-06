---
"permdock": patch
---

`permdock rls generate` with `rls.seeds: "view"` no longer writes the memo generation triggers on the `role_permissions` view. Postgres refuses `after` triggers on a view, so the generated helpers failed to apply. The view's rows change only with a migration, so the transaction-local memo never needs that bump.
