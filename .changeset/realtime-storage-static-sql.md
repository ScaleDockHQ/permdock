---
"permdock": minor
---

Breaking: under pg-delta, `rls.realtime` and `rls.storage` policies are static SQL at `realtime/permdock.sql` and `storage/permdock.sql`. The authz receive policy is `realtime/authz.sql`. They are no longer `do` blocks in the seeds migration. Apply them with an unscoped sync only where the service tables exist.
