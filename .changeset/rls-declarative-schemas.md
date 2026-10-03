---
"permdock": minor
---

`permdock rls generate --split helpers,policies,hook --out <dir>/056_permdock_{part}.sql` writes one file per part for Supabase declarative schemas, and `--grants-out <file>` (or `-` to print) moves the token hook's `supabase_auth_admin` grants, execute revoke and read policies into a migration of their own, since `supabase db diff` drops them. `permdock supabase hook generate` takes the same `--grants-out`. `--check` compares every part and the grants file and names the part that drifted. Doctor adds PD042 (error: the hook is declared under `supabase/schemas` and no migration from the one that creates it on grants it to `supabase_auth_admin`) and PD043 (warning: `schema_paths` applies a file that calls the helpers before the helpers part), and `doctor.migrations` now defaults to `supabase/schemas` too.
