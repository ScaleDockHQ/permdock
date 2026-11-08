---
"permdock": patch
---

The instance cache serialises a deeply frozen claims object once instead of on every request, and `supabaseClaims()` checks a frozen claims object once. An object that is not frozen is still serialised and checked on each call, so a changed object never reuses an old key. No generated SQL changes.
