---
'permdock': minor
---

`permdock/supabase` exports `supabaseTenantClaim` (`tenant_id`), the one default the hook, `subjectFromSupabase`, `supabaseRls`, `rls generate`, `rls verify` and `rlsParity` share. `permdock doctor` PD038 warns when a `subjectFromSupabase` or `subjectFromSupabaseSession` call reads the tenant from a different claim than `rls.tenantClaim`.
