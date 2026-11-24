---
"permdock": patch
---

Doctor `PD114` also runs in `rls.authorize: 'database'` mode: with `--db-url-stdin` it reports, as information, the sample users whose token keeps a partial membership list. `supabase.hook.membershipsClaim` keeps its default `true`; the hook docs record the claims-branch and table-branch timings behind that.
