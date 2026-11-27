---
"permdock": patch
---

PD110 and `permdock claims size` now measure the `tokens-only` session cookie as `@supabase/ssr` writes it. The claims are base64-encoded twice, once in the token and again in the cookie, so about 1,540 bytes of claims already splits the cookie into two chunks, far below the 4,096-character token ceiling. PD110 warns for a sample user whose cookie splits, and `claims size` prints the cookie's characters and chunks. The Supabase hook page adds "One cookie chunk": `membershipsClaim: false` with a tenant-scoped better-supabase bootstrap keeps every session in one chunk whatever the number of memberships.
