---
"permdock": minor
---

`custom_role_permissions` and `custom_role_includes` get a `unique … nulls not distinct` index named `*_nnd_key` in place of the `coalesce(...)` expression index (Postgres 15 or later; pg-delta drops the old `*_key` index, a migration project drops it once; `on conflict (coalesce(...))` in app SQL becomes `on conflict do nothing` or the column list). The approval store's pending index is partial (`expires_at where status = 'pending'`, named `*_pending_expires`). A membership source that reads its user through another table bumps the authorization version from statement triggers with transition tables, so a bulk write bumps each user once.
