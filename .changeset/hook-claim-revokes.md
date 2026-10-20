---
"permdock": patch
---

The generated Supabase token hook runs `revoke all on function <fn>(uuid|jsonb) from public, anon, authenticated` before granting each `supabase.hook.claims` and `supabase.hook.before` function to `supabase_auth_admin`, because those functions return any user's claims. Doctor PD049 names such a function while a client role can execute it. An app that calls one from the client grants it again in its own migration.
