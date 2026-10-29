---
"permdock": minor
---

`supabase.hook.security: "definer"` writes the access-token hook as `security definer`, grants `execute` to `supabase_auth_admin` only and skips the `supabase_auth_admin` read policies, so the hook reads tables with its owner's rights. The default stays `"invoker"`. `permdock doctor --db-url-stdin` runs the new PD085, which calls the hook as `supabase_auth_admin` for each `doctor.claims` sample and reports a Postgres error such as `permission denied for table`.
