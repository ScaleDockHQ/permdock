---
"permdock": patch
---

`permdock supabase hook generate` grants `supabase_auth_admin` usage on the schema of every table it reads outside the hook's schema, so a schema-qualified source such as `fromJunction({ table: 'better_supabase.memberships', … })` works without a hand-written grant.
