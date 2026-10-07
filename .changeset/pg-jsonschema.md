---
"permdock": minor
---

`rls.jsonSchema: true | 'auto'` adds a pg_jsonschema check constraint that each approval store `body` matches the new `schemas/approval-request-v1.json`. `supabase.hook.validate: true` makes the token hook check its claims against `supabase-claims-v1.json` and drop them all on a mismatch instead of failing sign-in.
