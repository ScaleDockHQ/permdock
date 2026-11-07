---
"permdock": minor
---

Breaking: under pg-delta, `rls.realtime` and `rls.storage` policies are static SQL beside the schema directory, at `supabase/service/realtime/permdock.sql` and `supabase/service/storage/permdock.sql`. The authz receive policy is `supabase/service/realtime/authz.sql`. A scoped declarative sync does not load them. Apply them where the service tables exist. They are no longer `do` blocks in the seeds migration.
