---
"permdock": minor
---

The Supabase manifest records where the token hook reads the active tenant (`hook.activeFrom`), and `authorizationProvider({ activeTenant })` reports in `problems` when better-supabase's `blocks.permissions.activeTenant` writes it elsewhere. `permdock doctor` reports the same mismatch as PD078 and lists each permission key a configured better-supabase block checks that the catalog lacks as PD079.
