---
"permdock": minor
---

`definePermDock(...).next()` from `permdock/better-supabase` adds `getSnapshot(source, { tenant, include?, omitAssignable?, omitStatic? })`, which builds one tenant's snapshot listing only that tenant's memberships: on the CentraKit-shaped admin with `omitStatic` it stays at 4,832 B for 1, 50 and 150 memberships, where the default snapshot grows to 7,322 B and 12,472 B. `readSubjectRecord` keeps a record's `tenant`, so a bootstrap subject read for one tenant seeds the subject cache under that tenant and never replaces the all-tenants record.
