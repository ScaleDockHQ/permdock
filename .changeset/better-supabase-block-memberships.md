---
"permdock": minor
---

`blockMembershipSource({ table?, roleThrough?, roles?, columns? })` from `permdock/better-supabase` is a `MembershipSource` over better-supabase's memberships block table, including a table the block runs over with `assignmentGuard: "external"`. `roleThrough` reads the role key through a roles table and `roles` reads several roles per member from a junction.
