---
"permdock": patch
---

The scope and permission-key helpers check the API key, token scope and interactive-only ceilings once instead of per row. `permitted_<scope>_ids(p_grant)` evaluates `permdock_api_key_allows`, `permdock_token_scope_allows` and `permdock_interactive_allows` once per call, where it used to call all three for every instance it returned. `permitted_<scope>_permission_keys` and its holders form first check once whether the session carries an API key, an OAuth client or an act, so a plain session skips the three calls for every grant key. `permdock_bootstrap_permissions` reads the platform keys from one `permitted_<root>_permission_keys(null)` call instead of one `permdock_has_permission` call per global key. On a member of 11 organizations with about 200 grant keys each, `permdock_bootstrap_permissions` drops from about 440 ms to about 40 ms on a small Supabase instance. Regenerate the RLS SQL to pick this up.
