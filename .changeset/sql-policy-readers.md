---
"permdock": minor
---

Doctor PD037, PD051, PD052 and PD090 and `permdock rls import --sql` read `create policy` statements through libpg_query instead of regular expressions. PD052 and PD090 no longer take a `for update` in a subquery as the policy command, PD037 keeps the key of a policy whose expression holds `';'`, `rls import` reads `on public.orders` as table `orders` and role `public` in lower case, and a dump libpg_query rejects now stops `rls import` with its line and column instead of falling back to text.
