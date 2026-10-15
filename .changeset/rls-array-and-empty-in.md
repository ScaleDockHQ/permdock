---
"permdock": patch
---

Generated RLS quotes a role name that holds a comma, brace, quote, backslash or whitespace inside its array literal, so one role can never split into two, and compiles an empty `in` list to `false` and an empty `notIn` to `is not null`, the same answers as `can()`. Before, an empty list produced invalid SQL.
