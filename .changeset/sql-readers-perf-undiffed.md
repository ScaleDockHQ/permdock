---
"permdock": patch
---

Doctor PD103, PD104 and PD108 read policies through libpg_query, so a `for update` inside a subquery no longer becomes the command of a policy without a `for` clause. `permdock rls generate` and `permdock supabase hook generate` no longer write a moved grant twice when it has a comment after its `;`.
