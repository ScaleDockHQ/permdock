---
"permdock": patch
---

`permdock rls generate` emits cheaper helpers. A helper reads the memberships already in the token when the token's `authz_ver` matches the stored version, and falls back to the membership tables otherwise, so a stale token never grants more than the tables. The token scope map is an immutable function the planner evaluates once. Suspension checks fold into the membership joins instead of running as correlated subselects. On Supabase with database authorization, permitted ids are memoized per user, grant and statement in transaction-local settings, so a statement over many tables runs the helper once. Behaviour and grants are unchanged.
