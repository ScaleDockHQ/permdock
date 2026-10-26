---
"permdock": patch
---

Test the better-supabase provider against 0.13.0, 0.18.0 and 0.25.0, pin the example to 0.25.0, and regenerate its SQL and types. The peer floor stays `>=0.13.0`. Upstream 0.21 changes direct block calls to Results and timestamps to Temporal values; follow its migration guide when upgrading your own block code.

Include forward migrations for the example's active-tenant hook, 0.25 audit functions, claim-based membership resolver and membership-removal claim cleanup. Existing migrations remain unchanged; a Postgres regression test verifies fresh replay matches the changed declarative schema and removes only the departed tenant claim.
