---
"permdock": patch
---

Document that scope and tenant ids compare as exact text in `decide` and the SQL helpers, never lower-cased, and that producers emit `uuid::text`; the policy matrix and an RLS parity suite over a `uuid` column cover it.
