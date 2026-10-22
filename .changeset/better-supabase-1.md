---
"permdock": patch
---

`permdock/better-supabase` works with better-supabase 1.0. `subjectFromShareLink` reads the share-link row's `subject: { type, id }` that better-supabase 1.0 returns, as well as `subjectType` and `subjectId` from 0.13, and `ShareLinkRow` accepts both shapes. `authorizationProvider` leaves the new `portalSubjects` and `portalParties` templates unset, so its functions type check against 1.0. The peer range stays `>=0.13.0` with no upper bound.
