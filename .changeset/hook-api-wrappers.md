---
"permdock": minor
---

`supabase.hook.api: { schema?, prefix? }` makes `permdock supabase hook generate` write `public.permdock_subject_for`, `permdock_members_of` and `permdock_authz_version_for` (schema `public` and prefix `permdock_` by default), so a backend can call the hook's readers through the Data API without hand-written wrappers. Each is `security definer`, revoked from `public`, `anon` and `authenticated`, and granted to `service_role`: the only grant the hook makes to it, and only with `api`. `postgrestSources(client, { api })` takes the same setting and derives `schema`, `fn`, `membersFn` and `versionFn` from it; the four options still override.
