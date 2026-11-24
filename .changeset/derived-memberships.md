---
"permdock": minor
---

Breaking: `rls.memberships` and `rls.suspension` are derived from `supabase.hook.memberships` and `supabase.hook.suspension` when unset, so a project with junction sources gets claims-first helpers. Doctor `PD121` reports a written entry that disagrees with or restates its source, and `permdock codemod config --prune` deletes a restated one.
