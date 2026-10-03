---
"permdock": patch
---

RLS CLI fixes found by the coverage suite:

- `rls import` maps `= 0` and `= false` conditions instead of importing them as opaque.
- `rls import` treats only `auth.jwt()` and `auth.session()` as claim sources; `->>` on a column or on `(select auth.uid())` is no longer a `principal.claim.*` reference.
- The raw `rls import` fallback reads roles, `for` and `as restrictive` from the policy header only, so a `with check (...)` or a word inside `using` no longer leaks into them.
- A malformed `supabase.hook.memberships` entry gets the "takes fromTable / fromJunction sources" error instead of a `TypeError`.
- `rls generate` refuses any output that names `service_role`, in every target; before, the guard matched only `to`, `from` and `;` forms.
