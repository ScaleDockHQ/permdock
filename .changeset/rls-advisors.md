---
"permdock": minor
---

`permdock rls verify --advisors` runs `supabase db advisors --type security` on `--db` or the local stack, names the doctor check for each lint and exits 1 on a `WARN` or `ERROR` row. With `--revoke-columns`, the `<table>_visible_fields` companion now lives in the helper schema (`rls.schema`) instead of `public`, so Supabase's `security_definer_view` lint no longer flags it; regenerate to move it.
