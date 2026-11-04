---
"permdock": minor
---

Breaking: `permdock/better-supabase` requires better-supabase 0.53.0 or later (`>=0.53.0`). The approvals and share-link bridges call the object-input block clients, and a policy step with `escalateAfter` throws. Upgrade better-supabase, run `better-supabase codemod 0.53` and `upgrade`, then update permdock.
