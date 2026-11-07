---
"permdock": minor
---

Breaking: under pg-delta, `rls.realtime` policies are static SQL beside the schema directory, at `supabase/service/realtime/permdock.sql`, and the authz receive policy is `supabase/service/realtime/authz.sql`. A scoped declarative sync does not load them: apply them where `realtime.messages` exists. `rls.storage` policies move into the schema directory, to `<schemaDir>/storage/permdock.sql`, as static `create policy` statements. Neither is a `do` block in the seeds migration.
