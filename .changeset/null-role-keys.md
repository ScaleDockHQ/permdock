---
"permdock": patch
---

`subject_for`, `members_of` and the hook's memberships no longer emit `roles: [null]` for a membership row whose role column is null (a member who holds only custom roles). A null key is no role, and a row left with no roles is not a membership. Re-run `permdock supabase hook generate`.
