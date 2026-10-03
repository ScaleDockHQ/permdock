---
'permdock': minor
---

`permdock/eve` follows eve 0.70: `approval.response` reads the responder from `ctx.response.principal`, and a Cancel from an eligible responder records the approval as `rejected`, so the re-check denies. `permdock/drizzle` accepts drizzle-orm 1.0 release candidates next to 0.40 and later, and recognises 1.0 array columns (`dimensions`) for `contains`. The `@supabase/middleware` peer range is now `>=1`.
