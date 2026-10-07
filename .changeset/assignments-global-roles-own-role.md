---
"permdock": minor
---

`rls.assignments` now guards the global-roles table. When `rls.roles` (else `supabase.hook.roles`) names the application's table, `rls generate` puts a `permdock_assignment` trigger on it too: a client role may insert, change or delete only the global roles it may assign, checked like a tenant assignment at no instance through `permdock_can_assign(role, null)` and, for a platform custom role, `permdock_can_assign_custom_role(null, 'global', null, role)`. A client that holds no global role whose `assigns` lists the role can no longer give itself or anyone else a global role through the Data API. The generated `user_roles` table is unchanged, since no client role may write it. The hook manifest lists the table in `rls.assignments.tables`.

`rls.assignments.ownRole: 'refuse'` refuses a client write to a row whose user is the caller, on every guarded table with a user column, whatever the role; a map such as `{ 'public.user_roles': 'refuse' }` limits it to the tables it names. A listed table names its user column with the new `user` field. The refusal raises SQLSTATE `42501` with hint `self-demotion` for the old row and `not-assignable-by` for the new one. `permdock doctor` PD064 warns on a table `rls.assignments` guards that no migration or `rls.out` file creates the `permdock_assignment` trigger on.

An application that sets both `rls.assignments` and `rls.roles` and lets clients write its global-roles table directly gets those writes checked after regenerating; move such writes into a `security definer` function or a backend role, which stay trusted.
