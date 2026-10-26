---
"permdock": minor
---

Breaking: `permdock/better-supabase` requires better-supabase 0.29.0 or later. `ShareLinkRow` takes only `subject: { type, id }`, so a share-link row with `subjectType` and `subjectId` now denies, and `authorizationHooks` caps an automation run with `bsb_permission_cap` only. Before upgrading, run `better-supabase migrate schema-first` if your `better-supabase.config.ts` has `tables` or `records`, then `better-supabase upgrade` and generate a migration.
