---
"permdock": minor
---

`supabase.hook.membershipsClaim: false` keeps the token hook's `memberships` claim empty and sets `memberships_truncated` for a member, so readers take the subject from the database. At 500 memberships the claims stay at 588 bytes instead of 28.8 KB unbudgeted (`scripts/hook-bench.json`). It needs `rls.authorize: 'database'`; `generate` exits 2 in `jwt` mode.
