---
"permdock": patch
---

Compile PowerSync memberships with `disabledAt` to `IS NULL` filters instead of excluding their streams. Honour `rls.suspension.memberships.keep` in declared grants, membership conditions and custom-role levels; keep `expiresAt` gaps and stop reporting suspension alone as a PD058 source gap.
