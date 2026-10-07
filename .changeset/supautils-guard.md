---
"permdock": minor
---

`permdock doctor` reports PD063, an error, for a migration that alters or drops a reserved Supabase role or grants a reserved membership, which supautils rejects. `permdock rls generate` refuses to write such a statement.
