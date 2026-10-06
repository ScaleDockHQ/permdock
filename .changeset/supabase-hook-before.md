---
"permdock": minor
---

`supabase.hook.before` names schema-qualified functions `(event jsonb) returns jsonb` that the generated `custom_access_token_hook` calls first, in order. A result with an `error` key is returned as the hook's answer, so Supabase Auth refuses the token, and a `null` or non-object result is refused with status 500; otherwise the hook continues with the event the function returned and writes its own claims as before. The migration grants `supabase_auth_admin` `usage` on each function's schema and `execute` on the function, and the Supabase manifest lists them as `hook.before`. Use it for checks such as single sign-on enforcement that must run inside the one hook Supabase allows. Nothing changes without it.
