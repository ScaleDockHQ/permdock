---
"permdock": patch
---

`permdock rls generate` emits cheaper helpers. A helper reads the memberships already in the token when the token's `authz_ver` matches the stored version, and falls back to the membership tables otherwise, so a stale token never grants more than the tables. The token scope map is an immutable function the planner evaluates once. Suspension checks fold into the membership joins instead of running as correlated subselects. On Supabase with database authorization, permitted ids are memoized in transaction-local settings under one key per scope and grant, and the stored value carries a discriminator for the user, token version, memo generation and statement. A helper reuses the value only while the discriminator matches, so the key set stays bounded on a pooled backend and a permission, custom-role or suspension write recomputes inside the same statement. The memoized helpers are volatile because the memo write is volatile. Behaviour and grants are unchanged.

Memberships written with row triggers off (`session_replication_role = replica`, disabled triggers or `TRUNCATE`) leave the stored `authz_ver` unchanged, so tokens minted before keep their memberships until they expire. The memo trusts the same session GUC store as `request.jwt.claims`: any role able to call `set_config` can forge both.
