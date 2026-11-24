---
"permdock": patch
---

PD095, PD099 and PD101 and the `rls generate` index and table scan read SQL through libpg_query, so a statement inside a comment, a string or a function body no longer counts; the generate trigger notes read `create or replace trigger` and skip triggers inside function bodies.
