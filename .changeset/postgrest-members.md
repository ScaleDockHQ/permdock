---
"permdock": minor
---

The hook file defines `members_of(p_scope text, p_id text) returns jsonb` next to `subject_for`: every live membership of one scope instance as `[{ principal: { id }, membership }]`, read from the hook's membership sources with their expiry and suspension filters, executable by no client role. `postgrestSources(client, { membersFn? })` calls it for `memberships.list`, once per instance, so `countHolders` and `whoCan` work over PostgREST. Regenerate the hook and grant the new function to your backend role the way you granted `subject_for`.
