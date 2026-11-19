---
"permdock": patch
---

PD107 no longer reports a custom-role probe in a function that a later migration or the schema files define again, since the database runs the last definition. `authorize()` from `permdock/supabase` now compares the custom-role `tenant_id` uncast, through a variable of the column's type, so the tenant index serves it. Regenerate the `authorize()` SQL to pick it up.
