---
'permdock': minor
---

`permdock rls generate` on Supabase writes `member_<scope>_ids_for(p_user uuid)` for each scope with a membership source (`rls.membershipSources` or `supabase.hook.memberships`) or a mapped `rls.memberships` table. It answers what `member_<scope>_ids()` answers, for `p_user`, from the membership tables, with the same expiry and suspension rules, so a `supabase.hook.claims` function can read the user's scopes before a token exists. `execute` is revoked from `public`, `anon` and `authenticated`. With `supabase.hook.claims` set, `permdock supabase hook generate` grants it to `supabase_auth_admin` (in the `--grants-out` file when given), and the hook manifest and PD039 list the `member_<scope>_ids` and `member_<scope>_ids_for` helpers.
