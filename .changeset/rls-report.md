---
"permdock": minor
---

`permdock rls report [--json]` lists each table's policies by command and role, with `permissive` or `restrictive`, the origin (`library`, `provider`, `app`), the helpers and keys each calls, sorted by helper calls per statement; with `--db-url-stdin` or `--local` it reads `pg_policies` and lists the indexed columns whose `=` is not leakproof. Doctor warning PD131 reports a table with more than `doctor.policies.max` (default 4, as better-supabase's BS641) policies for one command and `authenticated`.
